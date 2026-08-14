import * as NetworkConfig from '../lib/network-config';

describe('network-config の整合性 (実際の設定値)', () => {
  test('全 VPC CIDR は範囲としても重複しない (包含関係も検出)', () => {
    const cidrs = NetworkConfig.allVpcCidrs();
    const overlaps = cidrs.flatMap((a, i) =>
      cidrs
        .slice(i + 1)
        .filter((b) => {
          const [aStart, aEnd] = NetworkConfig.cidrToRange(a);
          const [bStart, bEnd] = NetworkConfig.cidrToRange(b);
          return aStart <= bEnd && bStart <= aEnd;
        })
        .map((b) => `${a} <-> ${b}`),
    );
    expect(overlaps).toEqual([]);
  });

  test('全トンネル内側 CIDR は重複しない', () => {
    const cidrs = NetworkConfig.allTunnelInsideCidrs();
    const overlaps = cidrs.flatMap((a, i) =>
      cidrs
        .slice(i + 1)
        .filter((b) => {
          const [aStart, aEnd] = NetworkConfig.cidrToRange(a);
          const [bStart, bEnd] = NetworkConfig.cidrToRange(b);
          return aStart <= bEnd && bStart <= aEnd;
        })
        .map((b) => `${a} <-> ${b}`),
    );
    expect(overlaps).toEqual([]);
  });

  test('CNE の ASN は全て asn-ranges の範囲内', () => {
    NetworkConfig.REGION_CONFIGS.forEach((r) => {
      expect(() =>
        NetworkConfig.assertAsnWithinRange(
          r.cneAsn,
          NetworkConfig.ASN.coreNetworkAsnRange,
          `CNE ASN (${r.code})`,
        ),
      ).not.toThrow();
    });
  });

  test('TGW の ASN とオンプレミスルーターの ASN は全て asn-ranges の範囲外', () => {
    NetworkConfig.REGION_CONFIGS.forEach((r) => {
      expect(() =>
        NetworkConfig.assertAsnOutsideRange(
          r.tgwAsn,
          NetworkConfig.ASN.coreNetworkAsnRange,
          `TGW ASN (${r.code})`,
        ),
      ).not.toThrow();
    });
    Object.values(NetworkConfig.ON_PREMISES_NETWORKS).forEach((n) => {
      expect(() =>
        NetworkConfig.assertAsnOutsideRange(
          n.routerAsn,
          NetworkConfig.ASN.coreNetworkAsnRange,
          `On-premises router ASN (${n.id})`,
        ),
      ).not.toThrow();
    });
  });

  test('prepend する ASN は asn-ranges の範囲外、かつ CNE の ASN と重複しない', () => {
    const cneAsns = NetworkConfig.REGION_CONFIGS.map((r) => r.cneAsn);
    NetworkConfig.ASN.prependAsnList.forEach((asn) => {
      expect(() =>
        NetworkConfig.assertAsnOutsideRange(
          asn,
          NetworkConfig.ASN.coreNetworkAsnRange,
          'Prepend ASN',
        ),
      ).not.toThrow();
      expect(() =>
        NetworkConfig.assertAsnDoesNotOverlap(asn, cneAsns, 'Prepend ASN'),
      ).not.toThrow();
    });
  });

  test('各 OnPremisesNetworkId に primary と secondary がちょうど 1 つずつ存在する', () => {
    (
      Object.keys(
        NetworkConfig.ON_PREMISES_NETWORKS,
      ) as NetworkConfig.OnPremisesNetworkId[]
    ).forEach((networkId) => {
      const primaries = NetworkConfig.REGION_CONFIGS.filter(
        (r) =>
          r.onPremisesNetwork === networkId && r.onPremisesRole === 'primary',
      );
      const secondaries = NetworkConfig.REGION_CONFIGS.filter(
        (r) =>
          r.onPremisesNetwork === networkId &&
          r.onPremisesRole === 'secondary',
      );
      expect(primaries).toHaveLength(1);
      expect(secondaries).toHaveLength(1);
    });
  });

  test('validateNetworkConfig は実際の設定値では throw しない', () => {
    expect(() => NetworkConfig.validateNetworkConfig()).not.toThrow();
  });

  test('個別のバリデーション関数も実際の設定値では throw しない', () => {
    expect(() => NetworkConfig.validateVpcCidrsDoNotOverlap()).not.toThrow();
    expect(() =>
      NetworkConfig.validateTunnelInsideCidrsDoNotOverlap(),
    ).not.toThrow();
    expect(() => NetworkConfig.validateCneAsnsWithinAsnRanges()).not.toThrow();
    expect(() =>
      NetworkConfig.validateTgwAsnsOutsideAsnRanges(),
    ).not.toThrow();
    expect(() =>
      NetworkConfig.validateOnPremisesRouterAsnOutsideAsnRanges(),
    ).not.toThrow();
    expect(() =>
      NetworkConfig.validatePrependAsnsOutsideAsnRanges(),
    ).not.toThrow();
    expect(() =>
      NetworkConfig.validatePrependAsnsDoNotOverlapCneAsns(),
    ).not.toThrow();
    expect(() =>
      NetworkConfig.validateOnPremisesNetworkRolesAreUnique(),
    ).not.toThrow();
  });
});

describe('バリデーション用の純関数 (異常値で throw すること)', () => {
  test('assertNoOverlappingCidrs: 重複する CIDR で throw する', () => {
    expect(() =>
      NetworkConfig.assertNoOverlappingCidrs(
        ['10.0.0.0/16', '10.0.0.0/16'],
        'test',
      ),
    ).toThrow();
  });

  test('assertNoOverlappingCidrs: 包含関係にある CIDR で throw する', () => {
    expect(() =>
      NetworkConfig.assertNoOverlappingCidrs(
        ['10.0.0.0/16', '10.0.1.0/24'],
        'test',
      ),
    ).toThrow();
  });

  test('assertNoOverlappingCidrs: 重複が無ければ throw しない', () => {
    expect(() =>
      NetworkConfig.assertNoOverlappingCidrs(
        ['10.0.0.0/16', '10.1.0.0/16'],
        'test',
      ),
    ).not.toThrow();
  });

  test('assertAsnWithinRange: 範囲外の ASN で throw する', () => {
    expect(() =>
      NetworkConfig.assertAsnWithinRange(65000, '64520-64534', 'test'),
    ).toThrow();
  });

  test('assertAsnWithinRange: 範囲内の ASN では throw しない', () => {
    expect(() =>
      NetworkConfig.assertAsnWithinRange(64520, '64520-64534', 'test'),
    ).not.toThrow();
  });

  test('assertAsnOutsideRange: 範囲内の ASN で throw する', () => {
    expect(() =>
      NetworkConfig.assertAsnOutsideRange(64520, '64520-64534', 'test'),
    ).toThrow();
  });

  test('assertAsnOutsideRange: 範囲外の ASN では throw しない', () => {
    expect(() =>
      NetworkConfig.assertAsnOutsideRange(65000, '64520-64534', 'test'),
    ).not.toThrow();
  });

  test('assertAsnDoesNotOverlap: 重複する ASN で throw する', () => {
    expect(() =>
      NetworkConfig.assertAsnDoesNotOverlap(64520, [64520, 64521], 'test'),
    ).toThrow();
  });

  test('assertAsnDoesNotOverlap: 重複が無ければ throw しない', () => {
    expect(() =>
      NetworkConfig.assertAsnDoesNotOverlap(
        4200000001,
        [64520, 64521],
        'test',
      ),
    ).not.toThrow();
  });

  test('CNE の ASN が asn-ranges の外だと throw する (validateCneAsnsWithinAsnRanges 相当の異常系)', () => {
    expect(() =>
      NetworkConfig.assertAsnWithinRange(
        65000,
        NetworkConfig.ASN.coreNetworkAsnRange,
        'CNE ASN',
      ),
    ).toThrow();
  });

  test('TGW の ASN が asn-ranges の中だと throw する (validateTgwAsnsOutsideAsnRanges 相当の異常系)', () => {
    expect(() =>
      NetworkConfig.assertAsnOutsideRange(
        64520,
        NetworkConfig.ASN.coreNetworkAsnRange,
        'TGW ASN',
      ),
    ).toThrow();
  });

  test('オンプレミスルーターの ASN が asn-ranges の中だと throw する', () => {
    expect(() =>
      NetworkConfig.assertAsnOutsideRange(
        64520,
        NetworkConfig.ASN.coreNetworkAsnRange,
        'On-premises router ASN',
      ),
    ).toThrow();
  });

  test('prepend する ASN が asn-ranges の中だと throw する', () => {
    expect(() =>
      NetworkConfig.assertAsnOutsideRange(
        64520,
        NetworkConfig.ASN.coreNetworkAsnRange,
        'Prepend ASN',
      ),
    ).toThrow();
  });

  test('prepend する ASN が CNE の ASN と重複すると throw する', () => {
    const cneAsns = NetworkConfig.REGION_CONFIGS.map((r) => r.cneAsn);
    const secondaryJpCneAsn = NetworkConfig.regionConfigOf(
      'jp',
      'secondary',
    ).cneAsn;
    expect(() =>
      NetworkConfig.assertAsnDoesNotOverlap(
        secondaryJpCneAsn,
        cneAsns,
        'Prepend ASN',
      ),
    ).toThrow();
  });
});

describe('派生値を導出する純関数', () => {
  test('vpnNameTagValue: code から Name タグ値を組み立てる', () => {
    expect(NetworkConfig.vpnNameTagValue('apne1')).toBe('apne1-tgw-vpn');
    expect(NetworkConfig.vpnNameTagValue('usw2')).toBe('usw2-tgw-vpn');
  });

  test('regionConfigOf: OnPremisesNetworkId と role から一意に RegionConfig を引ける', () => {
    expect(NetworkConfig.regionConfigOf('jp', 'primary').code).toBe('apne1');
    expect(NetworkConfig.regionConfigOf('jp', 'secondary').code).toBe(
      'apne3',
    );
    expect(NetworkConfig.regionConfigOf('us', 'primary').code).toBe('use1');
    expect(NetworkConfig.regionConfigOf('us', 'secondary').code).toBe(
      'usw2',
    );
  });

  test('secondaryCneOnPremisesGuardAsns: secondary CNE の ASN とオンプレミス拠点のルーター ASN の全組み合わせを返す', () => {
    expect(NetworkConfig.secondaryCneOnPremisesGuardAsns()).toEqual(
      expect.arrayContaining([
        { asn: 64521, onPremisesRouterAsn: 65000 },
        { asn: 64521, onPremisesRouterAsn: 65001 },
        { asn: 64523, onPremisesRouterAsn: 65000 },
        { asn: 64523, onPremisesRouterAsn: 65001 },
      ]),
    );
    expect(NetworkConfig.secondaryCneOnPremisesGuardAsns()).toHaveLength(4);
  });
});
