import * as CoreNetworkPolicy from '../lib/core-network-policy';
import * as NetworkConfig from '../lib/network-config';

// eslint 不要。生成結果を型なしで検証する
type AnyPolicy = Record<string, any>;

const MODES: readonly NetworkConfig.RoutingPolicyMode[] = [
  'off',
  'prepend',
  'localPreference',
];

/** prepend 方式の 3 スコープ */
const PREPEND_SCOPES: readonly NetworkConfig.PrependScope[] = [
  'minimal',
  'withPrimaryFallback',
  'all',
];

/** REGION_CONFIGS の全 (edge, peer) 直積 (edge !== peer) を "edge->peer" 文字列集合にする */
const allRegionPairs = (): Set<string> =>
  new Set(
    NetworkConfig.REGION_CONFIGS.flatMap((edge) =>
      NetworkConfig.REGION_CONFIGS.filter(
        (peer) => peer.region !== edge.region,
      ).map((peer) => `${edge.region}->${peer.region}`),
    ),
  );

/** segment-actions から "edge-location->peer-edge-location" 文字列集合を作る */
const actionPairSet = (policy: AnyPolicy): Set<string> =>
  new Set(
    policy['segment-actions'].map(
      (a: AnyPolicy) =>
        `${a['edge-location-association']['edge-location']}->${a['edge-location-association']['peer-edge-location']}`,
    ),
  );

/**
 * `minimal` スコープ (4 ペア) の期待値。
 * ローカル経路を持たない CNE が secondary から直接受け取る分だけ
 * (課題の表を直書き。実装の述語をそのまま転記すると述語のバグを検出できないため)
 */
const MINIMAL_PAIRS = new Set([
  'us-east-1->ap-northeast-3',
  'us-west-2->ap-northeast-3',
  'ap-northeast-1->us-west-2',
  'ap-northeast-3->us-west-2',
]);

/** `withPrimaryFallback` で `minimal` に追加される 2 ペア (同じペアの primary が受け取る分) */
const WITH_PRIMARY_FALLBACK_ADDITIONAL_PAIRS = new Set([
  'ap-northeast-1->ap-northeast-3',
  'us-east-1->us-west-2',
]);

describe('buildCoreNetworkPolicy (全モード共通)', () => {
  test.each(MODES)('%s: version は 2025.11', (mode) => {
    const policy = CoreNetworkPolicy.buildCoreNetworkPolicy(mode) as AnyPolicy;
    expect(policy.version).toBe('2025.11');
  });

  test.each(MODES)('%s: network-function-groups は空配列で存在する', (mode) => {
    const policy = CoreNetworkPolicy.buildCoreNetworkPolicy(mode) as AnyPolicy;
    expect(policy['network-function-groups']).toEqual([]);
  });

  test.each(MODES)(
    '%s: dns-support と security-group-referencing-support は true',
    (mode) => {
      const policy = CoreNetworkPolicy.buildCoreNetworkPolicy(
        mode,
      ) as AnyPolicy;
      const config = policy['core-network-configuration'];
      expect(config['dns-support']).toBe(true);
      expect(config['security-group-referencing-support']).toBe(true);
    },
  );

  test.each(MODES)(
    '%s: core-network-configuration.edge-locations が 4 件で REGION_CONFIGS と一致する',
    (mode) => {
      const policy = CoreNetworkPolicy.buildCoreNetworkPolicy(
        mode,
      ) as AnyPolicy;
      const edgeLocations = policy['core-network-configuration'][
        'edge-locations'
      ];
      expect(edgeLocations).toHaveLength(4);
      expect(edgeLocations).toEqual(
        NetworkConfig.REGION_CONFIGS.map((r) => ({
          location: r.region,
          asn: r.cneAsn,
        })),
      );
    },
  );

  test.each(MODES)('%s: segments[0].edge-locations が 4 件', (mode) => {
    const policy = CoreNetworkPolicy.buildCoreNetworkPolicy(mode) as AnyPolicy;
    expect(policy.segments[0]['edge-locations']).toHaveLength(4);
    expect(policy.segments[0]['edge-locations']).toEqual(
      NetworkConfig.REGION_CONFIGS.map((r) => r.region),
    );
  });

  test.each(MODES)(
    '%s: inside-cidr-blocks と vpn-ecmp-support は JSON 全体のどこにも存在しない',
    (mode) => {
      // inside-cidr-blocks は edge-locations[] 配下にも書ける仕様のため、
      // core-network-configuration 直下だけでなく JSON 全体で不在を確認する
      const json = JSON.stringify(CoreNetworkPolicy.buildCoreNetworkPolicy(mode));
      expect(json).not.toContain('inside-cidr-blocks');
      expect(json).not.toContain('vpn-ecmp-support');
    },
  );

  test.each(MODES)(
    '%s: JSON 全体に attachment-routing-policy-rules と routing-policy-label が含まれない',
    (mode) => {
      const json = JSON.stringify(CoreNetworkPolicy.buildCoreNetworkPolicy(mode));
      expect(json).not.toContain('attachment-routing-policy-rules');
      expect(json).not.toContain('routing-policy-label');
    },
  );

  test.each(MODES)(
    '%s: set-local-preference の value が存在すれば改行を含まない文字列',
    (mode) => {
      // off / prepend には set-local-preference アクション自体が存在しないため
      // この検証は空振り (vacuously true) になる。localPreference では実際に
      // 検証されることを別テストで保証する。
      const policy = CoreNetworkPolicy.buildCoreNetworkPolicy(
        mode,
      ) as AnyPolicy;
      (policy['routing-policies'] ?? []).forEach((rp: AnyPolicy) => {
        rp['routing-policy-rules'].forEach((rule: AnyPolicy) => {
          const action = rule['rule-definition'].action;
          if (action.type === 'set-local-preference') {
            expect(typeof action.value).toBe('string');
            expect(action.value).not.toContain('\n');
          }
        });
      });
    },
  );
});

describe('buildCoreNetworkPolicy (off)', () => {
  const policy = CoreNetworkPolicy.buildCoreNetworkPolicy('off') as AnyPolicy;

  test('routing-policies キー自体を持たない', () => {
    expect(policy).not.toHaveProperty('routing-policies');
  });

  // policy 2025.11 は空配列を受け付けないキーがあるため、空配列ではなくキーごと省略する
  test('segment-actions キー自体を持たない', () => {
    expect(policy).not.toHaveProperty('segment-actions');
  });
});

describe('buildCoreNetworkPolicy (prepend)', () => {
  test.each(PREPEND_SCOPES)(
    '%s: routing-policies が 1 件、ルールが 4 本 (スコープはルールに影響しない)',
    (scope) => {
      const policy = CoreNetworkPolicy.buildCoreNetworkPolicy(
        'prepend',
        scope,
      ) as AnyPolicy;
      expect(policy['routing-policies']).toHaveLength(1);
      expect(
        policy['routing-policies'][0]['routing-policy-rules'],
      ).toHaveLength(4);
    },
  );

  test.each(PREPEND_SCOPES)(
    '%s: match-conditions が secondaryCneOnPremisesGuardAsns() の全組み合わせと AND で一致し、全ルールが prepend-asn-list を持つ',
    (scope) => {
      const policy = CoreNetworkPolicy.buildCoreNetworkPolicy(
        'prepend',
        scope,
      ) as AnyPolicy;
      const rules = policy['routing-policies'][0]['routing-policy-rules'];
      const matchedPairs = rules.map((rule: AnyPolicy) => {
        const conditions = rule['rule-definition']['match-conditions'];
        expect(conditions).toHaveLength(2);
        conditions.forEach(
          (c: AnyPolicy) => expect(c.type).toBe('asn-in-as-path'),
        );
        return { asn: conditions[0].value, onPremisesRouterAsn: conditions[1].value };
      });
      expect(matchedPairs).toEqual(
        expect.arrayContaining([
          ...NetworkConfig.secondaryCneOnPremisesGuardAsns(),
        ]),
      );
      expect(matchedPairs).toHaveLength(4);
      rules.forEach((rule: AnyPolicy) => {
        expect(rule['rule-definition']['condition-logic']).toBe('and');
        expect(rule['rule-definition'].action.type).toBe('prepend-asn-list');
        expect(rule['rule-definition'].action.value).toEqual([
          ...NetworkConfig.ASN.prependAsnList,
        ]);
      });
    },
  );

  test('minimal: segment-actions が 4 件で、表の 4 ペアと完全一致する', () => {
    const policy = CoreNetworkPolicy.buildCoreNetworkPolicy(
      'prepend',
      'minimal',
    ) as AnyPolicy;
    expect(policy['segment-actions']).toHaveLength(4);
    expect(actionPairSet(policy)).toEqual(MINIMAL_PAIRS);
  });

  test('withPrimaryFallback: segment-actions が 6 件で、minimal の 4 件 + 追加 2 件と一致する', () => {
    const policy = CoreNetworkPolicy.buildCoreNetworkPolicy(
      'prepend',
      'withPrimaryFallback',
    ) as AnyPolicy;
    expect(policy['segment-actions']).toHaveLength(6);
    const expected = new Set([
      ...MINIMAL_PAIRS,
      ...WITH_PRIMARY_FALLBACK_ADDITIONAL_PAIRS,
    ]);
    expect(actionPairSet(policy)).toEqual(expected);
  });

  test('all: segment-actions が 12 件で、4 リージョンの直積 (自分以外) を過不足なく覆う', () => {
    const policy = CoreNetworkPolicy.buildCoreNetworkPolicy(
      'prepend',
      'all',
    ) as AnyPolicy;
    expect(policy['segment-actions']).toHaveLength(12);
    expect(actionPairSet(policy)).toEqual(allRegionPairs());
  });
});

describe('buildCoreNetworkPolicy (localPreference)', () => {
  const policy = CoreNetworkPolicy.buildCoreNetworkPolicy(
    'localPreference',
  ) as AnyPolicy;

  test('segment-actions が 12 件、routing-policies が 1 件', () => {
    expect(policy['segment-actions']).toHaveLength(12);
    expect(policy['routing-policies']).toHaveLength(1);
  });

  test('segment-actions は全 (edge-location, peer-edge-location) ペアを過不足なく覆う', () => {
    const actions = policy['segment-actions'];
    const actual = new Set(
      actions.map(
        (a: AnyPolicy) =>
          `${a['edge-location-association']['edge-location']}->${a['edge-location-association']['peer-edge-location']}`,
      ),
    );
    expect(actual).toEqual(allRegionPairs());
  });

  test('ルールが 5 本 (boost 1 本 + secondary 減点 4 本)', () => {
    expect(
      policy['routing-policies'][0]['routing-policy-rules'],
    ).toHaveLength(5);
  });

  test('set-local-preference アクションが実際に存在する (改行なしテストが空振りでないことの保証)', () => {
    const json = JSON.stringify(policy);
    const values = [...json.matchAll(/"set-local-preference"/g)];
    expect(values.length).toBeGreaterThan(0);
  });

  test.each(PREPEND_SCOPES)(
    '%s: prependScope に何を指定しても segment-actions は 12 件のまま (localPreference は全ペア固定)',
    (scope) => {
      const scoped = CoreNetworkPolicy.buildCoreNetworkPolicy(
        'localPreference',
        scope,
      ) as AnyPolicy;
      expect(scoped['segment-actions']).toHaveLength(12);
      expect(actionPairSet(scoped)).toEqual(allRegionPairs());
    },
  );
});

/** segment-actions[].edge-location-association.routing-policy-names を集める */
const referencedRoutingPolicyNames = (policy: AnyPolicy): string[] =>
  (policy['segment-actions'] ?? []).flatMap(
    (a: AnyPolicy) =>
      a['edge-location-association']?.['routing-policy-names'] ?? [],
  );

describe('整合性: segment-actions が参照する名前は routing-policies に実在する', () => {
  test.each(MODES)('%s', (mode) => {
    const policy = CoreNetworkPolicy.buildCoreNetworkPolicy(mode) as AnyPolicy;
    const definedNames = (policy['routing-policies'] ?? []).map(
      (rp: AnyPolicy) => rp['routing-policy-name'],
    );
    referencedRoutingPolicyNames(policy).forEach((name) => {
      expect(definedNames).toContain(name);
    });
  });
});

describe('policy 2025.11 の書式制約 (全モード)', () => {
  test.each(MODES)(
    '%s: routing-policy-name (定義側と segment-actions からの参照側の両方) は英数字のみ / 先頭が英字 / 64 文字以下',
    (mode) => {
      const policy = CoreNetworkPolicy.buildCoreNetworkPolicy(
        mode,
      ) as AnyPolicy;
      const definedNames = (policy['routing-policies'] ?? []).map(
        (rp: AnyPolicy) => rp['routing-policy-name'],
      );
      const names = [...definedNames, ...referencedRoutingPolicyNames(policy)];
      names.forEach((name: string) => {
        expect(name).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
        expect(name.length).toBeLessThanOrEqual(64);
      });
    },
  );

  test.each(MODES)(
    '%s: routing-policy-description は ASCII のみ / 空白を含まない / 256 文字以下',
    (mode) => {
      const policy = CoreNetworkPolicy.buildCoreNetworkPolicy(
        mode,
      ) as AnyPolicy;
      const descriptions = (policy['routing-policies'] ?? []).map(
        (rp: AnyPolicy) => rp['routing-policy-description'],
      );
      descriptions.forEach((description: string) => {
        expect(description).toMatch(/^[\x00-\x7F]*$/);
        expect(description).not.toMatch(/\s/);
        expect(description.length).toBeLessThanOrEqual(256);
      });
    },
  );
});

describe('prepend する ASN が asn-ranges の外であること', () => {
  test('ASN.prependAsnList は asn-ranges の外', () => {
    NetworkConfig.ASN.prependAsnList.forEach((asn) => {
      expect(() =>
        NetworkConfig.assertAsnOutsideRange(
          asn,
          NetworkConfig.ASN.coreNetworkAsnRange,
          'Prepend ASN',
        ),
      ).not.toThrow();
    });
  });

  test('prepend のポリシーに書かれた ASN も asn-ranges の外', () => {
    const policy = CoreNetworkPolicy.buildCoreNetworkPolicy(
      'prepend',
    ) as AnyPolicy;
    const values: number[] = policy['routing-policies'][0][
      'routing-policy-rules'
    ].flatMap(
      (rule: AnyPolicy) => rule['rule-definition'].action.value as number[],
    );
    values.forEach((asn) => {
      expect(() =>
        NetworkConfig.assertAsnOutsideRange(
          asn,
          NetworkConfig.ASN.coreNetworkAsnRange,
          'Prepend ASN',
        ),
      ).not.toThrow();
    });
  });
});
