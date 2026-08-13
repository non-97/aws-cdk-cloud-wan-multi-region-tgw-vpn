# Cloud WAN マルチリージョン TGW + Site-to-Site VPN の経路制御検証環境

Cloud WAN の Routing Policy で「ローカル TGW を持たないリージョンがどのリージョンの TGW を経由するか」を制御できるかを実測するための検証環境です。jp ペア (apne1 / apne3) と us ペア (use1 / usw2) の合計 4 リージョン 2 ペアで構成します。

背景と設計の詳細は次のドキュメントを参照してください。

- [../06-routing-policy.md](../06-routing-policy.md) — Routing Policy の仕様調査
- [../07-verification-environment.md](../07-verification-environment.md) — 検証環境の設計と検証手順

## 検証したいこと

**ローカル TGW を持たないリージョンとオンプレミス相当ネットワークとの通信を、平常時は同じペアの primary TGW 経由、primary TGW の Site-to-Site VPN がダウンしたときは secondary TGW 経由にする。**

## 構成

| リージョン | code | 役割 | リソース |
|---|---|---|---|
| ap-northeast-1 | apne1 | jp ペアの primary | Cloud WAN 直アタッチ VPC 10.0.0.0/16 <br> TGW 配下 VPC 10.10.0.0/16 <br> オンプレミス相当 VPC 10.100.0.0/16 (Cloud WAN 未接続) <br> TGW (ASN 64512) <br> Site-to-Site VPN |
| ap-northeast-3 | apne3 | jp ペアの secondary | Cloud WAN 直アタッチ VPC 10.1.0.0/16 <br> TGW 配下 VPC 10.11.0.0/16 <br> TGW (ASN 64513) <br> Site-to-Site VPN |
| us-east-1 | use1 | us ペアの primary | Cloud WAN 直アタッチ VPC 10.2.0.0/16 <br> TGW 配下 VPC 10.12.0.0/16 <br> オンプレミス相当 VPC 10.200.0.0/16 (Cloud WAN 未接続) <br> TGW (ASN 64514) <br> Site-to-Site VPN |
| us-west-2 | usw2 | us ペアの secondary | Cloud WAN 直アタッチ VPC 10.3.0.0/16 <br> TGW 配下 VPC 10.13.0.0/16 <br> TGW (ASN 64515) <br> Site-to-Site VPN |

VPN ルーターは 2 台です。jp 用ルーターは apne1 のオンプレミス相当 VPC に置き、apne1 と apne3 の TGW から合わせて 4 本の IPsec トンネルと 4 本の BGP セッションを終端します。us 用ルーターも同様に use1 のオンプレミス相当 VPC に置き、use1 と usw2 の TGW から 4 本ずつを終端します。実行したルーターが担当するオンプレミス相当ネットワークのプレフィックスだけが影響を受けます。

## スタック

| スタック | リージョン |
|---|---|
| `CloudWanRoutingCoreStack` | ap-northeast-1 |
| `CloudWanRoutingRegionStack-apne1` | ap-northeast-1 |
| `CloudWanRoutingRegionStack-apne3` | ap-northeast-3 |
| `CloudWanRoutingRegionStack-use1` | us-east-1 |
| `CloudWanRoutingRegionStack-usw2` | us-west-2 |
| `CloudWanRoutingDashboardStack` | ap-northeast-1 |

`CloudWanRoutingDashboardStack` は全リージョンの Transit Gateway Flow Logs (tcp-flags=0 のみ、TGW ごとにパネルを分割) を一覧表示する CloudWatch Dashboard を作る。各パネルは CloudWatch Logs Insights の `LogQueryWidget` の `region` プロパティでクロスリージョン表示しているため、スタック自体は ap-northeast-1 にあるが、表示内容は他リージョンの内容を含む。4つの `CloudWanRoutingRegionStack-*` に依存する。

4 つの `CloudWanRoutingRegionStack-*` はいずれも `CloudWanRoutingCoreStack` に依存します。**secondary のスタック (apne3 / usw2) は同じペアの primary のスタック (apne1 / use1) にも依存します。** secondary の CustomerGateway が primary の VPN ルーターの Elastic IP をクロスリージョン参照するため、同じペアの primary と secondary を並列にデプロイできません。異なるペア同士 (jp ペアと us ペア) には依存関係が無く、並列にデプロイできます。

## 前提

- Node.js / pnpm / AWS CLI / jq
- `awsume` で認証を通してから `aws sts get-caller-identity` で確認する
**デプロイ先のアカウントはコードに固定していません。** CDK CLI が現在の認証情報から渡す `CDK_DEFAULT_ACCOUNT` を使います。認証を通さずに CDK CLI を実行すると、`bin` のガードが次のエラーで止めます。

```
CDK_DEFAULT_ACCOUNT is not set. Run `awsume <profile>` and verify with `aws sts get-caller-identity` before running the CDK CLI.
```

`cdk synth` / `cdk ls` / `cdk deploy` はいずれも認証が必要です。`cdk.context.json` は AZ のキャッシュで、初回の `cdk synth` で現在のプロファイルのアカウントを使って自動生成されます。

`jest` は環境非依存でスタックを生成するため認証不要です。

`npx` は使いません。`node_modules/.bin/<bin>` を直接叩くか `pnpm exec` を使ってください。

## デプロイ

```bash
pnpm install
```

```bash
node_modules/.bin/cdk deploy --all
```

## DEPLOYMENT_SCOPE

`lib/network-config.ts` の `DEPLOYMENT_SCOPE` を編集して `cdk deploy --all` を再実行すると、Cloud WAN 一式 (`CloudWanRoutingCoreStack`) を作らずに TGW + Site-to-Site VPN だけをデプロイできます。

```ts
export const DEPLOYMENT_SCOPE: DeploymentScope = 'full';   // 'full' | 'vpnOnly'
export const VPN_ONLY_TARGET_NETWORK: OnPremisesNetworkId = 'jp';
```

Cloud WAN のアタッチメントは削除に時間がかかり、試行錯誤の回転が悪いという課題があります。デプロイ前に最もリスクが高い箇所を先に潰すためのモードです。最もリスクが高い箇所とは、1 台の VPN ルーターで 4 本の IPsec トンネルを同居させられるかどうかです。

| 値 | 内容 |
|---|---|
| `full` (既定) | 5 スタックすべて (`CloudWanRoutingCoreStack` + 4 リージョン) をデプロイする |
| `vpnOnly` | `CloudWanRoutingCoreStack` を作らず、`VPN_ONLY_TARGET_NETWORK` が示すペアの primary / secondary の 2 リージョンだけをデプロイする |

### 確認できること / できないこと

`vpnOnly` で確認できること。

- 1 台のルーターで 4 トンネルが UP になるか (最大のリスク)
- BGP セッションが 4 本 Established になるか
- ブートストラップスクリプトが 2 リージョンの VPN 接続をタグで見つけられるか
- TGW 配下 VPC からオンプレミス相当の疎通確認用 EC2 へ ping が通るか

`vpnOnly` で確認できないこと。

- Cloud WAN を作らないため CNE 間の経路選択と Routing Policy の効果は測れません。`ROUTING_POLICY_MODE` と `PREPEND_SCOPE` は `vpnOnly` では一切効きません。
- `set-return-path.sh` の best path 切り替えは測れません。VPN ルーターが受け取るのは apne1 TGW からの 10.10.0.0/16 と apne3 TGW からの 10.11.0.0/16 で別プレフィックスなので競合しません。同一プレフィックスが両 TGW から届く状況は Cloud WAN が経路を配って初めて成立します。
- `fail-primary-vpn.sh` のフェイルオーバー効果も測れません。代替経路が無いため、経路が消えることまでしか確認できません。

### vpnOnly での実機確認手順

1. `lib/network-config.ts` の `DEPLOYMENT_SCOPE` を `'vpnOnly'` に変更する
2. `node_modules/.bin/cdk ls` で `CloudWanRoutingRegionStack-apne1` と `CloudWanRoutingRegionStack-apne3` の 2 つだけが出力されることを確認する
3. `node_modules/.bin/cdk deploy --all` でデプロイする
4. VPN ルーター (apne1 のオンプレミス相当 VPC) に「SSM Session Manager での接続」のセクションの手順で接続し、「VPN ルーター上での操作」のセクションの手順で 4 トンネルの UP と BGP セッションの Established を確認する
5. TGW 配下 VPC の疎通確認用 EC2 から、オンプレミス相当 VPC の疎通確認用 EC2 へ ping する

### full へ戻すとき

`DEPLOYMENT_SCOPE` を `'full'` に戻す前に、必ず `node_modules/.bin/cdk diff --all` でリソースの置き換え (Replacement) が出ないことを確認してから `cdk deploy --all` を実行してください。

**`full` から `vpnOnly` へ戻す向きの切り替えは避けてください。** Cloud WAN のアタッチメント削除は時間がかかり、過去に change event queue の飽和でデッドロックになった事例があります。

## Routing Policy の切り替え

`lib/network-config.ts` の 2 つの定数を編集して再デプロイします。`cdk.json` の context や `-c` は使いません。

```ts
export const ROUTING_POLICY_MODE: RoutingPolicyMode = 'off';   // 'off' | 'prepend' | 'localPreference'
export const PREPEND_SCOPE: PrependScope = 'minimal';          // 'minimal' | 'withPrimaryFallback' | 'all'
```

| モード | 内容 | 用途 |
|---|---|---|
| `off` | Routing Policy を適用しない | ベースライン <br> 不定性と AS_PATH 等長の実測 |
| `prepend` | prepend <br> `PREPEND_SCOPE` でエントリ数を切り替える | CNE 間トランジットの判定 <br> AS_PATH 方式の効果測定 |
| `localPreference` | `set-local-preference` 方式 | local preference の観測 |

`PREPEND_SCOPE` は `prepend` モードにのみ効きます。`localPreference` は常に全 12 ペアに適用されます。

| スコープ | エントリ数 | 採用するペア |
|---|---|---|
| `minimal` | 4 | use1 ← apne3 / usw2 ← apne3 / apne1 ← usw2 / apne3 ← usw2 |
| `withPrimaryFallback` | 6 | 上記 + apne1 ← apne3 / use1 ← usw2 |
| `all` | 12 | 全ペア |

```bash
node_modules/.bin/cdk deploy CloudWanRoutingCoreStack
```

変更セットの完了を待ってから測定してください。手動で切り戻す場合は `restore-core-network-policy-version` だけでは LIVE が変わりません。`execute-core-network-change-set` まで実行する必要があります。

## 観測

| コマンド | 内容 |
|---|---|
| `./scripts/get-fib.sh` | Cloud WAN の FIB (確定ルート) を 4 エッジロケーション分取得する <br> **Routing Policy の効果確認はこちらで行う** |
| `./scripts/get-rib.sh` | Cloud WAN の RIB (BGP 属性付きの候補ルート) <br> **ポリシー適用前の情報しか返さない** |

RIB を見て「ポリシーが効いていない」と誤判断しないでください。`list-core-network-routing-information` は routing policy 適用前の状態を返します。

Network Manager の API リージョンは `NM_REGION` で上書きできます (既定は us-west-2)。

### どちらの TGW を通ったかの判断方法

| 方向 | 方法 | 種別 |
|---|---|---|
| 戻り (オンプレミス相当 → VPC) | VPN ルーター上で `sudo ip netns exec vrf1 ip route get <VPC の IP>` | ルーターの FIB |
| 行き (VPC → オンプレミス相当) | VPN ルーター上で `sudo tcpdump -ni vtiN host <VPC の IP>` を 4 本ぶん | データプレーン実測 |
| 両方 | Cloud WAN の FIB (`./scripts/get-fib.sh`) | コントロールプレーン |
| 両方 | Transit Gateway Flow Logs の `tgw-id` | AWS 側のデータプレーン |

`ip route get` は `via 169.254.10.1 dev vti1` のように返ります。トンネル内側 CIDR を固定しているため、169.254.10.x なら apne1、169.254.20.x なら apne3、169.254.30.x なら use1、169.254.40.x なら usw2 と一意に読めます。

`traceroute` は使えません。AWS の VGW と Cloud WAN の core edge が ICMP Time Exceeded を返さない仕様のため、ホップに出てきません。この観測手段は Site-to-Site VPN の検証環境の構成に依存しており、本番の DXGW 構成には転用できません。

## VPN ルーター上での操作

VPN ルーターは 2 台あります。jp 用と us 用でそれぞれ独立に操作してください。ルーターへは「SSM Session Manager での接続」のセクションの手順で接続します。SSM Session Manager は Core Network の経路に依存しないため、経路断の検証中でも接続できます。

### 戻り方向の経路を切り替える

```bash
sudo /opt/set-return-path.sh primary
```

`primary` / `secondary` / `none` を指定します。route-map を適用したあとに `clear bgp vrf vrf1 <neighbor> soft in` を自動で実行します。これが無いと受信済みの経路が再評価されず `show ip bgp` が変化しません。

**注意**: この設定は `vtysh` の実行時設定のみで、`write memory` していません。FRR を再起動すると `none` に戻ります。

### primary 側の Site-to-Site VPN を落とす

```bash
sudo ./scripts/fail-primary-vpn.sh
sudo ./scripts/restore-primary-vpn.sh
```

primary 側 2 トンネルの外側 IP を iptables で遮断します。FRR の `neighbor shutdown` は使いません。IPsec が UP のまま残り `describe-vpn-connections` の `VgwTelemetry[].Status` が UP を返すため、「Site-to-Site VPN がダウンした場合」という検証条件と証跡が食い違うためです。

遮断後は `VgwTelemetry[].Status` が DOWN になることを確認してください。

### 状態確認

```bash
sudo vtysh -c "show ip bgp summary"
sudo vtysh -c "show ip bgp vrf vrf1"
sudo ipsec status
cat /etc/vpn-router-neighbors.env
```

## トラブルシュート

VPN ルーターの初期設定 (`vpn-router-bootstrap.sh`) は、systemd timer (`vpn-router-converge.timer`) が収束するまで 5 分間隔で再実行します。timer と service unit は user data が設置します。最終状態は `/run/vpn-router-status` に 1 行で残ります。

### `/run/vpn-router-status` の値

| 値 | 意味 |
|---|---|
| (ファイルが無い) | - 未収束の状態 <br>- user data 未到達 <br>- または起動直後でこれから収束処理が走る |
| `pending:timer-installed` | user data は成功した <br>- ブートストラップ本体 (`vpn-router-bootstrap.sh`) がまだ未実行か実行中 |
| `failed:env-missing` | - `/etc/vpn-router.env` が無い <br>- または必須変数が足りない |
| `failed:package-install` | `dnf install` (jq / libreswan / spal-release / frr) に失敗した |
| `failed:imds` | IMDS から public-ipv4 または local-ipv4 を取得できなかった |
| `failed:vpn-lookup` | 4 トンネル分の VPN 接続情報 (外側 IP / トンネル内側 CIDR / 事前共有鍵) が揃わなかった |
| `failed:eth1` | - device-number=1 のインタフェースが見つからない <br>- または vrf1 への移動に失敗した |
| `failed:ipsec-up` | 4 本のうち 1 本以上が `ipsec auto --up` を 30 回試しても established にならなかった |
| `failed:vti` | - 30 回試しても 4 本の VTI デバイスが揃わない <br>- または vrf1 への移動に失敗した |
| `failed:frr` | `frr` サービスの起動に失敗した |
| `ok` | IPsec 4 本 + VTI 4 本 + FRR サービスの起動までが完了した |

**`ok` は IPsec 4 本と VTI 4 本と FRR サービスの起動が完了したことを意味し、BGP ネイバーが Established になったことは意味しません。** この切り分けは意図した設計です。

- IPsec トンネルと VTI デバイスは本スクリプトが作るものなので、失敗したら本スクリプト自身が再試行する必要があります。`failed:ipsec-up` / `failed:vti` はそのために `exit 1` します
- BGP セッションの確立は FRR 自身が継続的に再試行します。本スクリプトが再実行して面倒を見る対象ではありません
- むしろ BGP が未確立であることを理由に 5 分ごとに本スクリプトを再実行すると、`systemctl restart ipsec` が実行されるたびに、収束しかけている IPsec トンネルを落とし直すことになります

BGP セッションの実際の状態は `ok` の値とは別に、「状態確認」章の `vtysh` コマンドで確認してください。

### ログの確認

`vpn-router-bootstrap.sh` の標準出力と標準エラーは、user data 自体の実行ログ (`/var/log/cloud-init-output.log`) とは別に `/var/log/vpn-router-bootstrap.log` に残ります。

```bash
sudo cat /run/vpn-router-status
sudo tail -n 100 /var/log/vpn-router-bootstrap.log
sudo systemctl list-timers vpn-router-converge.timer
```

### SSM Session Manager での接続

VPN ルーターの IAM ロールには `AmazonSSMManagedInstanceCore` が付いているため、Session Manager で直接ログインできます。

```bash
aws ssm start-session \
  --target <インスタンス ID> \
  --region <VPN ルーターのリージョン>
```

### `ssm send-command` でスクリプトを直接流す

CloudFormation のデプロイサイクルを回さずに、修正版のスクリプトを直接流して検証を回せます。1 サイクルが 10 分から数十秒になります。

```bash
aws ssm send-command \
  --instance-ids <インスタンス ID> \
  --region <VPN ルーターのリージョン> \
  --document-name AWS-RunShellScript \
  --parameters commands="sudo bash /opt/vpn-router-bootstrap.sh"
```

修正版のスクリプトをまだ S3 / インスタンスに反映していない場合は、`--parameters commands=` にスクリプト全文を直接渡すか、修正後のファイルを一旦 S3 に上げてインスタンス上で `aws s3 cp` してから実行してください。

## テスト

```bash
node_modules/.bin/jest
```

スナップショットに加え、次の項目を Fine-grained assertions とネガティブアサーションで固定しています。`REGION_CONFIGS` をループして検証するため、リージョンを追加してもテストファイルの書き換えは不要です。

- オンプレミス相当 VPC と TGW 配下 VPC が Cloud WAN にアタッチされていないこと
- TGW のルートテーブルが 1 つだけであること
- Transit Gateway Flow Logs が 1 つで `MaxAggregationInterval` が 60 であること
- VPN ルーターの ENI 2 枚がいずれも `SourceDestCheck: false` であること
- EC2 Instance Connect Endpoint の個数が primary 1 個 (オンプレミス相当のみ) / secondary 0 個であること
- VPN Connection に `PreSharedKey` が含まれないこと
- VPN Connection の `Name` タグが `vpnNameTagValue(code)` と一致すること
- ポリシー JSON の識別子が英数字のみ、description が ASCII で空白を含まないこと
- `set-local-preference` の値に改行が含まれないこと
- `attachment-routing-policy-rules` と `routing-policy-label` が出力に含まれないこと
- `PREPEND_SCOPE` ごとの `segment-actions` が `minimal` 4 件 / `withPrimaryFallback` 6 件 / `all` 12 件と一致すること
- `localPreference` はどの `PREPEND_SCOPE` を指定しても `segment-actions` が全 12 ペア固定であること

## 設計上の重要な制約

### オンプレミス相当 VPC を Cloud WAN にアタッチしない

アタッチすると 10.100.0.0/16 や 10.200.0.0/16 が VPC アタッチメント由来の経路 (AS_PATH 長 1) として全 Core Network Edge へ広報され、TGW peering 経由の経路 (長さ 3) に AS_PATH 長で勝ちます。ローカル経路を持たない CNE がオンプレミス相当の CIDR を直接学習してしまい、primary TGW 経由と secondary TGW 経由の比較そのものが消えて検証が無効化されます。

### 疎通確認用 EC2 は VPN ルーターの eth1 と同一サブネットに置く

FRR の `aggregate-address <CIDR> summary-only` は、そのプレフィックスの Null0 ブラックホールをルーター自身に install します。別サブネットに置くとブラックホールに吸われて転送できなくなります。`ping` が `connect: Invalid argument` を返すのが目印です。

### TGW のルートテーブルは 1 つだけ

Cloud WAN が学習するのは TGW 全体ではなく、route table attachment で紐付けた 1 つのルートテーブルの中身だけです。Site-to-Site VPN アタッチメントと TGW 配下 VPC アタッチメントの association / propagation 先を別にすると、Cloud WAN 側にオンプレミス経路が現れず、**エラーも警告も出ないまま**リモートリージョン経由になります。

### 事前共有鍵をコードに書かない

`preSharedKey` を指定せず AWS の自動採番に任せ、VPN ルーターが起動時に `describe-vpn-connections` から取得します。

### VPN 接続はタグで検索する

VPN ルーターは `Name` タグ (`apne1-tgw-vpn` / `apne3-tgw-vpn` / `use1-tgw-vpn` / `usw2-tgw-vpn`) でタグ検索します。ID で渡すと、primary スタックが secondary の VPN 接続 ID を、secondary スタックが primary の Elastic IP を必要として参照が循環します。

## 後片付け

```bash
node_modules/.bin/cdk destroy --all
```

測定結果を記録してから削除してください。
