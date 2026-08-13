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
 * 欠落する。sort / display の有無、時間経過による取り込み遅延のいずれとも
 * 無関係で、同一データに対して再現する)。`filter @message like /^(?:\S+\s+)
 * {31}0\s/` (`parse` を経由しない、生ログへの正規表現一致) に置き換えると
 * 欠落なく安定することを実機で複数回確認済み。srcAddr / dstAddr /
 * flowDirection の表示用抽出は `filter` の対象にしないので `parse` のままで
 * 問題ない (`parse` して `display` するだけなら値は正しく出る)。
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
  'filter @message like /^(?:\\S+\\s+){31}0\\s/',
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
