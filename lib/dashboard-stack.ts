import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import type { RegionConfig } from './network-config';

/**
 * TGW Flow Logs の生ログを Logs Insights で読むためのクエリ。
 *
 * Transit Gateway Flow Logs のカスタムフォーマット
 * (`TGW_FLOW_LOG_FORMAT`、transit-gateway.ts) は 36 フィールドのスペース区切り。
 * `tcp-flags` (32番目) が `0` の行 (ping (ICMP) 等、TCP の SYN/ACK/FIN 等を
 * 持たない通信) だけに絞り込み、ログ量を減らす。
 *
 * **絞り込みは `parse` で抽出したフィールドを `filter` にかけるのではなく、
 * `filter @message like /正規表現/` で生の `@message` に対して直接行う。**
 * `parse @message /.../ as tcpFlags` で抽出した値は正しく `"0"` になり、
 * クオート付きで `filter tcpFlags = "0"` と文字列比較しても、本来一致する
 * はずの行の過半数が結果から欠落する不具合を実機で確認した (`parse` の
 * 抽出結果自体は `display` で見ると正しいのに、同じ値への `filter` だけが
 * 欠落する)。`filter @message like /^(?:\S+\s+){31}0\s/`
 * (`parse` を経由しない、生ログへの正規表現一致) に置き換えても、
 * **有界の繰り返し量指定 `{31}` を使う限り欠落が再発する** (2026-08-13
 * に別データで確認。同一 ICMP 往復のうち行き方向の行だけ一致し帰り方向の
 * 行は一致しない欠落が、CloudWatch API の `recordsMatched` 自体の値で
 * 裏取りできた。フィールド数・値は往復どちらも文字列として完全に同一)。
 * **回避策は `{31}` のような有界の繰り返し量指定を使わず、対象フィールドの
 * 前後にある固定文字列のリテラル一致に置き換えること。** このプロジェクトの
 * TGW Flow Log フォーマット (`transit-gateway.ts` の `TGW_FLOW_LOG_FORMAT`)
 * では、`tcp-flags` (32番目) の直前の4フィールド (`packets-lost-*`、
 * 28〜31番目) が正常系では常に `0 0 0 0` になるため、`type` (27番目、
 * 常に `IPv4`) から続けて `IPv4 0 0 0 0 0` というリテラル部分一致にすれば
 * 位置カウントを使わずに済む。この形で全4行が正しく揃うことを実機で確認済み
 * (詳細はスキル aws-verification-gotchas の references/misc.md 参照)。
 * **既知の限界**: 実際にパケットロス (`packets-lost-*` のいずれかが非0) が
 * 記録された行は、tcp-flags が 0 であってもこのリテラルに一致せず
 * 拾えない。この用途 (ping 等 SYN/ACK/FIN を持たない通信の把握) では
 * 許容している。`parse` 側の位置カウント (`{16}` / `{15}`) は今回の欠落と
 * 無関係であることを確認済みで (全4行で `srcAddr` / `dstAddr` /
 * `flowDirection` とも正しく抽出される)、変更していない。
 *
 * 表示列を絞るには `display` を使う。`parse` で作った ephemeral field
 * (`srcAddr` 等) を後段の `fields` で再指定すると
 * `MalformedQueryException: Ephemeral field is already defined` になり
 * クエリ自体が実行できない (実機で確認済み)。`display` はこの制約を受けない。
 *
 * `sort` は `@timestamp desc` に加えて `srcAddr asc` を副キーにしている。
 * 1回の通信は同一 TGW 内の2アタッチメント (ingress/egress) 分の行に分かれ、
 * かつ表示上ミリ秒未満の差はまとめて同一タイムスタンプに見えるため、
 * `@timestamp` だけでは往路 / 復路のペアが隣り合うとは限らない。
 * `srcAddr` を副キーにすることで、同一タイムスタンプ内は送信元 IP ごとに
 * まとまり、同じ向きの行が隣接するようになる (同一タイムスタンプ・同一
 * srcAddr の完全な同着はタイブレークが未定義で、実行ごとに順序が変わりうる)。
 */
const TGW_FLOW_LOG_QUERY = [
  'fields @timestamp, @logStream, @message',
  'filter @message like /IPv4 0 0 0 0 0/',
  'parse @message /^(?:\\S+\\s+){16}(?<srcAddr>\\S+)\\s+(?<dstAddr>\\S+)\\s+(?:\\S+\\s+){15}(?<flowDirection>\\S+)/',
  'display @timestamp, @logStream, srcAddr, dstAddr, flowDirection, @message',
  'sort @timestamp desc, srcAddr asc',
  'limit 100',
].join('\n| ');

export interface DashboardStackProps extends cdk.StackProps {
  /**
   * ダッシュボードに表示するリージョンの一覧。`RegionStack` を直接受け取らず
   * プレーンなオブジェクト配列にすることで、テストで実際の `RegionStack` を
   * 組み立てずに済むようにしている。
   */
  readonly regions: {
    readonly regionConfig: RegionConfig;
    readonly flowLogGroupName: string;
  }[];
}

/**
 * 全リージョンの Transit Gateway Flow Logs を一覧表示するダッシュボード。
 *
 * CloudWatch Dashboard の Logs Insights クエリウィジェット (`LogQueryWidget`)
 * は `region` プロパティを持ち、ダッシュボード自体とは別のリージョンの
 * ロググループを指定できる。これを使い、1つのダッシュボードに
 * リージョン (= TGW) ごとの一覧パネルを縦に並べる。
 */
export class DashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id, props);

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'CloudWanRouting-TgwFlowLogs',
    });
    // 検証環境を削除した後もウィジェット定義ごと参照できるように残す。
    // 参照先の TGW Flow Logs ロググループ自体も RemovalPolicy.RETAIN 済み
    // (transit-gateway.ts / site-to-site-vpn.ts) なので、ログデータと
    // ダッシュボードの両方が環境削除後も参照可能になる。
    dashboard.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    props.regions.forEach(({ regionConfig, flowLogGroupName }) => {
      dashboard.addWidgets(
        new cloudwatch.LogQueryWidget({
          title: `${regionConfig.region} TGW Flow Logs (tcp-flags=0)`,
          logGroupNames: [flowLogGroupName],
          region: regionConfig.region,
          queryString: TGW_FLOW_LOG_QUERY,
          width: 24,
          height: 8,
        }),
      );
    });
  }
}
