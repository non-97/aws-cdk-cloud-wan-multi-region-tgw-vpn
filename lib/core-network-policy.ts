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
 *    ASN 1 つで全件を捉える。`prepend` / `localPreference` のいずれも secondary
 *    リージョンの CNE ASN で「secondary CNE を経由したか」を判定する
 *    (`buildSegmentActionsForAllPairs` のコメントを参照)。
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
  observeLocalPreference: 'observeLocalPreference',
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

/**
 * 全 (edge-location, peer-edge-location) ペアに同じ routing-policy を一律で紐付ける
 * segment-actions を生成する。4 リージョンなので `4 × 3 = 12` エントリになる。
 *
 * **リージョンごとに適用先を出し分けない。** これが本番設計の核心である。
 * secondary の CNE (apne3 / usw2) に当てても、そのリージョン宛の経路には自分自身の
 * ASN が AS_PATH に乗らないためマッチせず、ローカル TGW が選ばれ続ける。つまり
 * 「全ペアへ一律適用 + マッチ条件は secondary CNE の ASN」という組み合わせだけで、
 * secondary リージョン自身は自リージョンの TGW を使い、他リージョンからの越境経路
 * だけ不利になるという要件がリージョンごとの出し分け無しに実現できる。
 *
 * また、この一律適用の設計は「ある CNE が別の CNE から受け取った経路を、改変後の
 * AS_PATH のまま再広報するか」という 2026-08 時点で AWS 公式記述が無く未確定の
 * 前提 (スキル aws-verification-gotchas 参照) にも依存しない。マッチ条件を
 * secondary CNE の ASN にしている限り、どの edge-location からの評価であっても
 * 「secondary CNE を経由した経路かどうか」を判定基準ひとつで区別できるため、
 * 再広報の実際の挙動がどちらであっても結果が変わらない。
 *
 * **この関数自体は `localPreference` 専用として残す。** 上記の「未確定の前提に
 * 依存しない」という性質は全 12 ペアに一律適用した場合の話であり、`prepend`
 * モードは `NetworkConfig.PREPEND_SCOPE` で意図的にペアを絞ることで、まさに
 * その未確定の前提 (CNE 間トランジットの有無 / 改変の引き継ぎ) を実測で
 * 切り分ける。`prepend` 用のペア絞り込みは `buildSegmentActionsForPrependScope`
 * (本関数の下) を参照。
 */
const buildSegmentActionsForAllPairs = (
  routingPolicyName: string,
): Record<string, unknown>[] =>
  NetworkConfig.REGION_CONFIGS.flatMap((edge) =>
    NetworkConfig.REGION_CONFIGS.filter(
      (peer) => peer.region !== edge.region,
    ).map((peer) => ({
      action: 'associate-routing-policy',
      segment: NetworkConfig.CLOUD_WAN.segmentName,
      'edge-location-association': {
        'routing-policy-names': [routingPolicyName],
        'edge-location': edge.region,
        'peer-edge-location': peer.region,
      },
    })),
  );

/**
 * prepend 方式の routing-policy を紐付ける segment-actions を、`PrependScope` で
 * 絞り込んだ (受信 CNE, 送信 CNE) ペアだけ生成する。
 *
 * `localPreference` (`buildSegmentActionsForAllPairs`) とは異なり、`prepend` は
 * 当たっていないペアの経路が既定の AS_PATH 長のまま評価されるだけ (prepend 0 回 =
 * 何もしないのと同じ) で済むため、全ペアに当てなくても意味は反転しない。ペアを
 * 絞ることで、CNE 間トランジットの有無と改変の引き継ぎという 2 つの未確定事項を
 * 実測で切り分けられる (詳細は `NetworkConfig.PREPEND_SCOPE` の JSDoc を参照)。
 */
const buildSegmentActionsForPrependScope = (
  routingPolicyName: string,
  scope: NetworkConfig.PrependScope,
): Record<string, unknown>[] =>
  NetworkConfig.prependScopePairs(scope).map(({ edge, peer }) => ({
    action: 'associate-routing-policy',
    segment: NetworkConfig.CLOUD_WAN.segmentName,
    'edge-location-association': {
      'routing-policy-names': [routingPolicyName],
      'edge-location': edge.region,
      'peer-edge-location': peer.region,
    },
  }));

/**
 * prepend 方式の routing-policy (1 件)。
 * secondary リージョンの数だけルールを生成し、rule-number は 100 刻みで採番する
 * (apne3 → rule 100, usw2 → rule 200)。マッチ条件は secondary CNE の ASN
 * (`asn-in-as-path`) であり、オンプレミスルーターの ASN ではない。オンプレミス
 * ルーターの ASN でマッチさせると、primary TGW 直の経路と「primary CNE が
 * secondary CNE から受け取って再広報した経路」がどちらも AS_PATH にオンプレミス
 * ルーターの ASN を含むため区別できない。secondary CNE の ASN でマッチさせれば、
 * AS_PATH に secondary CNE が含まれるかどうかで直接判定できる (注意点 2 を参照)。
 */
const buildPrependRoutingPolicy = (): Record<string, unknown> => ({
  'routing-policy-name': ROUTING_POLICY_NAME.deprioritizeSecondaryTransit,
  'routing-policy-description':
    'Prepend-ASN-on-routes-that-transited-a-secondary-CNE',
  'routing-policy-direction': 'inbound',
  'routing-policy-number': 100,
  'routing-policy-rules': NetworkConfig.secondaryCneAsns().map(
    (asn, index) => ({
      'rule-number': (index + 1) * 100,
      'rule-definition': {
        'match-conditions': [{ type: 'asn-in-as-path', value: asn }],
        'condition-logic': 'or',
        action: {
          type: 'prepend-asn-list',
          value: [...NetworkConfig.ASN.prependAsnList],
        },
      },
    }),
  ),
});

/**
 * local preference 方式の routing-policy (1 件)。
 *
 * **位置づけ**: 本番設計案ではなく、local preference が Route evaluation の
 * どこで効くかを測る観測用モードである。理由は以下の通り。
 *
 * 1. rule 100 は `prefix-equals: "0.0.0.0/0"` と `prefix-in-cidr: "0.0.0.0/0"` の
 *    2 条件を `or` で結び、実質的に全件にマッチさせる。これは「既定値を一旦
 *    引き上げてから、条件に合うものを後続ルールで下げる」という書き方を成立させる
 *    ための土台であり、同時に `match-conditions: []` という空配列が invalid で
 *    受理されないことの回避でもある (fallback として `prefix-in-cidr: "0.0.0.0/0"`
 *    を書く手法はスキル aws-verification-gotchas に記載の検証済み手法)。
 * 2. **このモードは「secondary リージョンはローカル TGW を使う」という要件を
 *    満たさない可能性がある。** local preference は CNE 間で伝播する属性であり、
 *    ローカルアタッチメント (TGW 直結) 由来の経路が持つ既定の local preference
 *    (0) を下げる手段が無い。そのため rule 100 で CNE 間経路を一律 300 に
 *    引き上げると、secondary リージョン自身から見ても「他 CNE 経由の経路」の
 *    ほうがローカル経路より優先されてしまい、secondary 自身が primary へ
 *    寄ってしまう可能性がある。**それが実際に起きるかどうかを観測することが
 *    このモードの目的であり、起きないことを保証する設計ではない。**
 * 3. `set-local-preference` の `value` は文字列だが、末尾に改行を付けない
 *    (ファイル冒頭の注意点 1 を参照)。
 */
const buildLocalPreferenceRoutingPolicy = (): Record<string, unknown> => ({
  'routing-policy-name': ROUTING_POLICY_NAME.observeLocalPreference,
  'routing-policy-description':
    'Observe-where-local-preference-affects-route-evaluation-across-CNEs',
  'routing-policy-direction': 'inbound',
  'routing-policy-number': 100,
  'routing-policy-rules': [
    {
      'rule-number': 100,
      'rule-definition': {
        'match-conditions': [
          { type: 'prefix-equals', value: '0.0.0.0/0' },
          { type: 'prefix-in-cidr', value: '0.0.0.0/0' },
        ],
        'condition-logic': 'or',
        action: {
          type: 'set-local-preference',
          value: String(NetworkConfig.LOCAL_PREFERENCE.preferred),
        },
      },
    },
    ...NetworkConfig.secondaryCneAsns().map((asn, index) => ({
      'rule-number': (index + 2) * 100,
      'rule-definition': {
        'match-conditions': [{ type: 'asn-in-as-path', value: asn }],
        'condition-logic': 'or',
        action: {
          type: 'set-local-preference',
          value: String(NetworkConfig.LOCAL_PREFERENCE.deprioritized),
        },
      },
    })),
  ],
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
  // rule 100 が全件マッチで local preference を 300 に引き上げ、rule 200 以降で
  // secondary 経由の経路だけ 50 に下げる構造のため、一部のペアだけに
  // routing-policy を当てると、当たっていないペアの経路は既定値 0 のまま残り、
  // 50 に下げた経路 (50 > 0) に経路選択で負けてしまい「secondary 経由を
  // 不利にする」という意図が反転する。この方式は全ペアに当てて初めて成立するため、
  // 常に `buildSegmentActionsForAllPairs` で全 12 ペアを使う。
  return {
    ...common,
    'routing-policies': [buildLocalPreferenceRoutingPolicy()],
    'segment-actions': buildSegmentActionsForAllPairs(
      ROUTING_POLICY_NAME.observeLocalPreference,
    ),
  };
};
