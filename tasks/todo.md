# Cloud WAN routing-policies 整理 + TGW Flow Logs 追加

## 事前確認 (完了)

- [x] `lib/network-config.ts` / `lib/core-network-policy.ts` / `lib/constructs/transit-gateway.ts` /
      `test/core-network-policy.test.ts` / `test/stacks.test.ts` を読了
- [x] `node_modules/aws-cdk-lib` の型定義で `CfnFlowLog` / `CfnFlowLogProps` を確認
  - `resourceType: string` (enum なし)。ただし L2 `ec2.FlowLogResourceType.fromTransitGatewayId()` の
    実装 (`vpc-flow-logs.js`) を見ると `resourceType: "TransitGateway"` の文字列を使っている → これを採用
  - `trafficType?: string` の JSDoc に "This parameter is not supported for transit gateway resource types."
    と明記あり → ユーザー指摘の「TGW は ACCEPT/REJECT フィルタ非対応」と一致、trafficType は指定しない
  - `deliverLogsPermissionArn?: iamRefs.IRoleRef | string` → `role.roleArn` で可
  - `logGroupName?: logsRefs.ILogGroupRef | string` → `logGroup.logGroupName` で可
- [x] 既存の Site-to-Site VPN ログ設定 (`lib/constructs/site-to-site-vpn.ts`) のパターンを確認
  (`logs.LogGroup` + `retention: ONE_MONTH` + `removalPolicy: DESTROY`)
- [x] `logs.LogGroup.grantWrite()` の実装を確認 → `logs:CreateLogStream` / `logs:PutLogEvents` を付与
  (Flow Logs 配信ロールへの書き込み権限付与に使う)
- [x] スキル `aws-verification-gotchas` の Cloud WAN 節を確認
  (asn-in-as-path を第一候補にする指針 / CNE 間トランジット未確定という事実と、
  ユーザー指示の「東京 CNE にポリシーを当てない」設計が整合することを確認)

## 変更 1: RoutingPolicyMode を 3 モードに整理

- [x] `lib/network-config.ts`: `RoutingPolicyMode` を `'off' | 'prepend' | 'localPreference'` に変更
- [x] `lib/core-network-policy.ts`:
  - [x] `ROUTING_POLICY_NAME.deprioritizeOsakaOnPrem` → `deprioritizeOsakaTransit` にリネーム
  - [x] `buildPrependRoutingPolicy` のマッチ条件を `ASN.onPremisesRouter` → `ASN.cne.osaka` に変更、
        description を `Prepend-ASN-on-routes-that-transited-Osaka-CNE` に変更
  - [x] マッチ条件変更の理由 (オンプレミス ASN だと東京 TGW 直と大阪トランジットが両方マッチして
        区別できない) をコメントに明記
  - [x] `buildPrependSegmentActionVirginiaFromOsaka` / `buildPrependSegmentActionTokyoFromOsaka` を
        統合し、受信側 us-east-1 / peer ap-northeast-1・ap-northeast-3 の 2 件を返す
        `buildPrependSegmentActions` に置き換え
  - [x] 東京 CNE にポリシーを当てない理由 (CNE 間トランジットの有無が未確認の前提になるため) を
        コメントに明記
  - [x] `buildCoreNetworkPolicy` の `prependSingle` / `prependDual` 分岐を `prepend` 1 本に統合
  - [x] `localPreference` 分岐は変更なし (マッチ条件が定数由来であることを確認済み)
  - [x] ファイル冒頭の注意点 2 のコメントも、モードごとにマッチ ASN が異なる旨に更新
- [x] `test/core-network-policy.test.ts`:
  - [x] `MODES` を `['off', 'prepend', 'localPreference']` に変更
  - [x] `prependSingle` / `prependDual` の describe ブロックを `prepend` 用に書き換え
        (segment-actions 2件、両方 edge-location=us-east-1、peer が ap-northeast-1 と ap-northeast-3、
        マッチ条件が asn-in-as-path で value = ASN.cne.osaka)
  - [x] 末尾の ASN 範囲外テストの `buildCoreNetworkPolicy('prependSingle')` を `'prepend'` に変更
  - [x] 改行なしテストを `test.each(MODES)` の共通ブロックへ移し (off/prepend は空振り)、
        localPreference 側は「アクションが実在すること」だけを保証する形に分離
        (advisor 指摘: 旧テストの `toBeGreaterThan(0)` 前提のままだと 3 モード共通化できない)

## 変更 2: TGW Flow Logs を CloudWatch Logs へ

- [x] `lib/constructs/transit-gateway.ts`:
  - [x] `aws-cdk-lib/core` / `aws-cdk-lib/aws-logs` / `aws-cdk-lib/aws-iam` を import
  - [x] `logs.LogGroup` (retention: ONE_MONTH, removalPolicy: DESTROY) を作成
  - [x] `iam.Role` (assumedBy: ServicePrincipal('vpc-flow-logs.amazonaws.com')) を作成し
        `logGroup.grantWrite(role)` + `grant(role, 'logs:DescribeLogStreams')` で書き込み権限を付与
        (CDK の L2 FlowLogDestination.toCloudWatchLogs と同じ 3 アクションに揃えた)
  - [x] `ec2.CfnFlowLog` を作成 (resourceType: 'TransitGateway', resourceId: tgw.ref,
        logDestinationType: 'cloud-watch-logs', logGroupName, deliverLogsPermissionArn,
        customLogFormat をシングルクォート文字列で指定、trafficType は指定しない)
  - [x] `packets-lost-blackhole` / `packets-lost-no-route` を含める理由をコメントに明記
- [x] `test/stacks.test.ts`:
  - [x] TokyoStack / OsakaStack に `AWS::EC2::FlowLog` が 1 つずつあることを確認するテストを追加
  - [x] LogFormat に `tgw-id` / `tgw-attachment-id` / `packets-lost-blackhole` が含まれることを確認
  - [x] VirginiaStack に `AWS::EC2::FlowLog` が存在しないことを確認するテストを追加

## 完了確認

- [x] `node_modules/.bin/tsc` → エラーなし
- [x] `node_modules/.bin/cdk synth CloudWanMultiRegionCoreNetworkStack CloudWanMultiRegionTokyoStack CloudWanMultiRegionOsakaStack CloudWanMultiRegionVirginiaStack --quiet` → 成功
- [x] `node_modules/.bin/jest -u` → 74 件全て pass、スナップショット更新は 2 件
      (Tokyo / Osaka のみ。ROUTING_POLICY_MODE は 'off' のままなので CoreNetworkStack /
      Virginia のスナップショットが変化していないことを確認し、意図しない副作用が無いことを確認)

## レビュー

- 事実確認: `CfnFlowLogProps.resourceType` は型としては `string` (enum なし)。実際に使う
  `'TransitGateway'` という文字列は、L2 `ec2.FlowLogResourceType.fromTransitGatewayId()` の
  コンパイル済み実装 (`node_modules/aws-cdk-lib/aws-ec2/lib/vpc-flow-logs.js`) で
  `{resourceType:"TransitGateway", ...}` と定義されていることで実在確認した。
- 同じ実装から、`trafficType` を渡すと TGW / TGW Attachment に対して **L2 (`ec2.FlowLog`)** が
  例外を投げること (`"trafficType is not supported for Transit Gateway and Transit Gateway Attachment"`)
  も確認したが、今回使う **L1 (`ec2.CfnFlowLog`) はこの制約を検証しない**。
  `CfnFlowLogProps.trafficType` の JSDoc の記載 (TGW 系リソースでは非対応) を根拠に、
  L1 でも意図的に指定しない設計にした。誤って指定しても synth は通り、デプロイ時に
  初めて失敗する類の罠であることをコメントに明記した。
- IAM 権限は `grantWrite` (CreateLogStream, PutLogEvents) だけでは CDK 自身の L2 FlowLog が
  付与する `DescribeLogStreams` が欠けるため、`grant()` で追加して揃えた。CfnFlowLog の
  バリデーションはこの権限差を検出しないため、実デプロイでログが正常に流れるかは別途要確認。
- `maxAggregationInterval` は指示の設定項目に含まれないため未設定 (デフォルト 600 秒)。
  JSDoc には「TGW 系リソースでは 60 秒固定にする必要がある」と読める記載があるが、
  L1 (CfnFlowLog) にはこのバリデーションが無いため synth は通る。実デプロイで
  600 秒のまま受理されるかは未検証 (指示範囲外のため今回は変更していない。要のんピ判断)。
- README.md (56-65 行) が `prependSingle` / `prependDual` を前提にした説明のままになっている。
  今回の指示は 5 ファイルへの変更に限定されていたため README.md は変更していない。
  他に `../06-routing-policy.md` (プロジェクト外) にも同様の記述がある可能性がある。
