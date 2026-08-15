/**
 * Core Network Policy ドキュメント (policy 2025.11) を生成する純関数。
 *
 * `vpn-ecmp-support` と `inside-cidr-blocks` は書かない。Cloud WAN に直接ぶら下がる
 * VPN も Connect アタッチメントも無く、`inside-cidr-blocks` は空配列が invalid で
 * key ごと省略するしかないため。
 *
 * 実機確認済みの重要な注意点 (詳細はスキル aws-verification-gotchas / references/cloud-wan.md):
 *
 * 1. `set-local-preference` の `value` は文字列だが、末尾に改行を付けてはいけない。
 *    過去に「CloudFormation の handler が数字だけの文字列を integer に coerce して
 *    TYPE_MISMATCH になるため、末尾に改行を付けて回避する」という知見を持っていたが、
 *    2026-08 の実機確認で逆に改行を付けるとエラーになることが判明し撤回された。
 *    素の数字文字列 (例: "300") をそのまま渡す。
 * 2. マッチ条件にオンプレミスの CIDR を列挙せず `asn-in-as-path` を使う。
 *    本番のオンプレミス側 CIDR は多数あり列挙が非現実的なため、AS_PATH に必ず含まれる
 *    CNE の ASN とオンプレミスルーターの ASN の組み合わせ (2 条件の and) で対象経路を
 *    特定する。`prepend` は secondary CNE の ASN で「secondary CNE を経由したか」を
 *    判定し、`localPreference` は primary CNE の ASN で「primary CNE を経由したか」を
 *    判定する。それぞれの詳細は buildPrependRoutingPolicy と
 *    buildLocalPreferenceRoutingPolicy のコメントを参照。
 * 3. `attachment-routing-policy-rules` 方式は使わない。`routing-policy-label` の
 *    付与はアタッチメントの Replacement を伴い、過去に 6 アタッチメント一括削除で
 *    change event queue が飽和して約 3 時間のデッドロックになった実績があるため。
 *    `edge-location-association` 方式はアタッチメントに一切触らずポリシーだけを
 *    差し替えられる。
 */

import * as NetworkConfig from './network-config';

/** routing-policy-name はハイフン不可 / 英字始まり / 英数字のみのため camelCase にする */
const ROUTING_POLICY_NAME = {
  deprioritizeSecondaryTransit: 'deprioritizeSecondaryTransit',
  preferPrimaryViaLocalPreference: 'preferPrimaryViaLocalPreference',
} as const;

/** モード共通のポリシー骨格 (segment-actions と routing-policies を除く) */
const buildCommonPolicy = (): Record<string, unknown> => ({
  version: '2025.11',
  'core-network-configuration': {
    'asn-ranges': [NetworkConfig.ASN.coreNetworkAsnRange],
    'dns-support': true,
    'security-group-referencing-support': true,
    'edge-locations': NetworkConfig.REGION_CONFIGS.map((r) => ({
      location: r.region,
      asn: r.cneAsn,
    })),
  },
  segments: [
    {
      name: NetworkConfig.CLOUD_WAN.segmentName,
      'require-attachment-acceptance': false,
      'isolate-attachments': false,
      'edge-locations': NetworkConfig.REGION_CONFIGS.map((r) => r.region),
    },
  ],
  'network-function-groups': [],
  'attachment-policies': [
    {
      'rule-number': 100,
      description: 'attach verification segment by tag',
      'condition-logic': 'or',
      conditions: [
        {
          type: 'tag-value',
          operator: 'equals',
          key: NetworkConfig.CLOUD_WAN.attachmentTagKey,
          value: NetworkConfig.CLOUD_WAN.segmentName,
        },
      ],
      action: {
        'association-method': 'constant',
        segment: NetworkConfig.CLOUD_WAN.segmentName,
      },
    },
  ],
});

/** (edge, peer) ペア配列から segment-actions を組み立てる共通ロジック */
const buildSegmentActionsForPairs = (
  routingPolicyName: string,
  pairs: readonly NetworkConfig.PrependPair[],
): Record<string, unknown>[] =>
  pairs.map(({ edge, peer }) => ({
    action: 'associate-routing-policy',
    segment: NetworkConfig.CLOUD_WAN.segmentName,
    'edge-location-association': {
      'routing-policy-names': [routingPolicyName],
      'edge-location': edge.region,
      'peer-edge-location': peer.region,
    },
  }));

/**
 * prepend 方式の routing-policy を紐付ける segment-actions を、`PrependScope` で
 * 絞り込んだ (受信 CNE, 送信 CNE) ペアだけ生成する。
 *
 * `prepend` は当たっていないペアの経路が既定の AS_PATH 長のまま評価されるだけ
 * (prepend 0 回 = 何もしないのと同じ) で済むため、全ペアに当てなくても意味は
 * 反転しない。`localPreference` (boost 方式) も、当たっていないペアの経路は
 * 既定の local preference 0 のまま残るだけなので同じ性質を持つ。両者の絞り込みの
 * 目的は異なる。`prepend` はこの性質を利用して、CNE 間トランジットの有無と改変の
 * 引き継ぎという 2 つの事項を実測で切り分けるためにペアを段階的に増やす
 * (詳細は `NetworkConfig.PREPEND_SCOPE` の JSDoc を参照)。`localPreference` は
 * 逆に、絞り込まないと primary 以外の経路まで優先させてしまい secondary が
 * 自リージョンの TGW を使うという要件を壊す実害が出るため絞り込む
 * (詳細は `buildSegmentActionsForLocalPreferenceBoost` のコメントを参照)。
 */
const buildSegmentActionsForPrependScope = (
  routingPolicyName: string,
  scope: NetworkConfig.PrependScope,
): Record<string, unknown>[] =>
  buildSegmentActionsForPairs(
    routingPolicyName,
    NetworkConfig.prependScopePairs(scope),
  );

/**
 * local preference boost 方式の routing-policy を紐付ける segment-actions を、
 * `NetworkConfig.localPreferenceBoostPairs()` が返す 4 ペアだけ生成する。
 *
 * 絞り込みが必要な理由は `buildLocalPreferenceRoutingPolicy` の JSDoc を参照。
 * 要約すると、絞り込まずに全 12 ペアへ適用すると secondary 自身が対象に含まれ、
 * secondary が自リージョンの TGW を手放しかねない実害が実測で確認されている。
 */
const buildSegmentActionsForLocalPreferenceBoost = (
  routingPolicyName: string,
): Record<string, unknown>[] =>
  buildSegmentActionsForPairs(
    routingPolicyName,
    NetworkConfig.localPreferenceBoostPairs(),
  );

/**
 * prepend 方式の routing-policy (1 件)。
 * secondary CNE の ASN × オンプレミス拠点のルーター ASN の全組み合わせだけ
 * ルールを生成し、rule-number は 100 刻みで採番する。
 *
 * マッチ条件は `asn-in-as-path` を 2 つ `and` で組み合わせる: (1) secondary CNE
 * の ASN、(2) オンプレミスルーターの ASN。(1) だけだと「secondary CNE を経由した
 * 経路」だけでなく「secondary CNE 自身が発信した経路 (自身の VPC / TGW 配下 VPC)」
 * にも一致してしまう (AS_PATH に secondary CNE の ASN が乗るのは経由時も発信元時も
 * 同じため)。secondary 自身が発信した経路の AS_PATH には secondary 自身の ASN しか
 * 乗らず、オンプレミスルーターの ASN (発信元 = AS_PATH の起点) は乗らないため、(2) を
 * `and` で足すことで発信元の経路を確実に除外できる (2026-08 実機評価で確認: 詳細は
 * `evidence/20260813/` を参照)。
 *
 * オンプレミス側の CIDR を列挙する (`prefix-equals`) 方式は採用しなかった:
 * オンプレミス拠点にサブネットが増えても列挙を追従できなければ保護対象から漏れる。
 * 拠点のルーター ASN は拠点ごとに 1 つで増減しないため、この方式は追従漏れが起きない。
 */
const buildPrependRoutingPolicy = (): Record<string, unknown> => ({
  'routing-policy-name': ROUTING_POLICY_NAME.deprioritizeSecondaryTransit,
  'routing-policy-description':
    'Prepend-ASN-on-routes-that-transited-a-secondary-CNE',
  'routing-policy-direction': 'inbound',
  'routing-policy-number': 100,
  'routing-policy-rules': NetworkConfig.secondaryCneOnPremisesGuardAsns().map(
    ({ asn, onPremisesRouterAsn }, index) => ({
      'rule-number': (index + 1) * 100,
      'rule-definition': {
        'match-conditions': [
          { type: 'asn-in-as-path', value: asn },
          { type: 'asn-in-as-path', value: onPremisesRouterAsn },
        ],
        'condition-logic': 'and',
        action: {
          type: 'prepend-asn-list',
          value: [...NetworkConfig.ASN.prependAsnList],
        },
      },
    }),
  ),
});

/**
 * local preference 方式の routing-policy (1 件)。primary CNE 経由の経路の
 * local preference だけを boost 方式で引き上げ、下げる操作は行わない。
 *
 * **位置づけ**: 本番設計案として成立する。旧方式は rule 100 で全件を 300 に
 * 引き上げてから secondary 一致分だけ 50 に下げ直す方式だった。この旧方式が
 * 抱えていた「既定値 0 を下回れない」という制約は、優先したい経路だけを
 * 引き上げる本方式には存在しない。既定値が 0 であることは AWS 公式ブログ Part 1
 * の "The default local preference is 0" で確認済みである
 * (出典: https://aws.amazon.com/blogs/networking-and-content-delivery/aws-cloud-wan-routing-policy-fine-grained-controls-for-your-global-network-part-1/)。
 * docs.aws.amazon.com 配下の正式リファレンスには同等の記載が無く、このブログのみが
 * 出典である。
 *
 * **本番採用前に実機検証が必要な事項**: AWS の Route evaluation ページ
 * (https://docs.aws.amazon.com/network-manager/latest/cloudwan/cloudwan-route-evaluation.html)
 * には local preference が一切記載されていない。同ページが定める動的ルートの
 * 評価順序は AS_PATH 長が最初であり、local preference が AS_PATH 長より優先
 * されるかどうかは未文書化である。boost の対象を絞り込んでいても、local
 * preference が AS_PATH 長に優先するという前提そのものが確認されるまでは、
 * 本番採用前に実機で優先関係を検証する必要がある。
 *
 * **絞り込みの必要性**: マッチ条件は primary CNE の ASN と、その primary が
 * 属するオンプレミス拠点のルーター ASN の組み合わせ (2 条件の and)。対象は
 * `NetworkConfig.localPreferenceBoostPairs()` が返す 4 ペアに限る。全 12 ペアに
 * 適用すると secondary 自身が対象に含まれてしまう。例えば (edge=apne3,
 * peer=apne1) が対象に入ると、apne3 が持つ自分のローカル TGW 経由の経路
 * (AS_PATH 長 2 / LP 0) より、apne1 経由の経路 (AS_PATH 長 3 / boost で LP 300)
 * のほうが優先されかねない。これは「secondary リージョンはローカル TGW を使う」
 * という要件を壊す。この危険性は実測でも裏付けられている。
 * `evidence/20260813/Routing Policy2設定後のrib.log` の EDGE=ap-northeast-3 と
 * EDGE=us-west-2 に、絞り込みが無ければ boost の対象になってしまう経路が実在する
 * ことを確認した。
 *
 * `set-local-preference` の `value` は文字列だが、末尾に改行を付けない
 * (ファイル冒頭の注意点 1 を参照)。
 */
const buildLocalPreferenceRoutingPolicy = (): Record<string, unknown> => ({
  'routing-policy-name': ROUTING_POLICY_NAME.preferPrimaryViaLocalPreference,
  'routing-policy-description':
    'Boost-local-preference-of-routes-that-transited-a-primary-CNE',
  'routing-policy-direction': 'inbound',
  'routing-policy-number': 100,
  'routing-policy-rules': NetworkConfig.primaryCneOnPremisesBoostAsns().map(
    ({ asn, onPremisesRouterAsn }, index) => ({
      'rule-number': (index + 1) * 100,
      'rule-definition': {
        'match-conditions': [
          { type: 'asn-in-as-path', value: asn },
          { type: 'asn-in-as-path', value: onPremisesRouterAsn },
        ],
        'condition-logic': 'and',
        action: {
          type: 'set-local-preference',
          value: String(NetworkConfig.LOCAL_PREFERENCE.preferred),
        },
      },
    }),
  ),
});

/**
 * Core Network Policy ドキュメントを返す純関数。
 *
 * `off` は `routing-policies` と `segment-actions` のキー自体を出力しない。
 * policy 2025.11 は空配列を受け付けないキーがあり (`inside-cidr-blocks` で実機確認済み)、
 * `segment-actions` が同様かは未確認のため、空配列を書くより省略する方が安全。
 * キーを持たないポリシーが受理されることは policy 2021.12 で実機確認済み。
 *
 * @param mode Routing Policy の適用モード
 * @param prependScope `prepend` モードの segment-actions を絞り込む範囲。
 *   既定は `NetworkConfig.PREPEND_SCOPE` (実運用の切り替えはそちらの定数を編集する)。
 *   テストから 3 段階を直接指定できるよう引数として公開する。
 *   **`localPreference` には適用しない** (下記コメント参照)。
 */
export const buildCoreNetworkPolicy = (
  mode: NetworkConfig.RoutingPolicyMode,
  prependScope: NetworkConfig.PrependScope = NetworkConfig.PREPEND_SCOPE,
): Record<string, unknown> => {
  const common = buildCommonPolicy();

  if (mode === 'off') {
    return common;
  }

  if (mode === 'prepend') {
    return {
      ...common,
      'routing-policies': [buildPrependRoutingPolicy()],
      'segment-actions': buildSegmentActionsForPrependScope(
        ROUTING_POLICY_NAME.deprioritizeSecondaryTransit,
        prependScope,
      ),
    };
  }

  // localPreference
  // ここには prependScope を反映しない (引数を受け取っていても無視する)。
  // boost 方式は primary CNE 経由の経路だけを優先させれば要件を満たせるため、
  // 全ペアへの一律適用は不要かつ有害。絞り込みが必要な理由は
  // buildLocalPreferenceRoutingPolicy の JSDoc を参照。
  return {
    ...common,
    'routing-policies': [buildLocalPreferenceRoutingPolicy()],
    'segment-actions': buildSegmentActionsForLocalPreferenceBoost(
      ROUTING_POLICY_NAME.preferPrimaryViaLocalPreference,
    ),
  };
};
