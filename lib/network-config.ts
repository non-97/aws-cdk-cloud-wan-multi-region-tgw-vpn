/**
 * 検証環境のネットワーク設定を一元管理する。
 * アカウント / リージョン / VPC CIDR / ASN / トンネル内側 CIDR / Cloud WAN の固定値 /
 * Routing Policy の適用モードをここで定義し、Stack / Construct には Props 経由で注入する。
 * synth 時に走らせる整合性検証 (CIDR 重複 / ASN の範囲チェック) の純関数もここに置く。
 *
 * リージョン追加は `REGION_CONFIGS` への要素追加のみで済むようにする。個別の
 * `tokyo` / `osaka` 定数を持つ形にすると追加のたびに定義漏れが起きるため、
 * リージョンごとの値は配列 1 本に集約し、派生値は全て純関数で導出する
 * (定数表を二重に持たない)。
 */

// デプロイ先のアカウント ID はここに固定値で持たない。CDK CLI が現在の認証情報から
// 渡す CDK_DEFAULT_ACCOUNT を bin 側で解決する (bin/aws-cdk-cloud-wan-multi-region-tgw-vpn.ts)。
// 固定値を書くと、プロファイルを切り替えたときに実際のデプロイ先と食い違う。

/** オンプレミス相当ネットワークの識別子 (日本側 / 米国側) */
export type OnPremisesNetworkId = "jp" | "us";

/** ペア内でのリージョンの役割。オンプレミスとの通信は primary の TGW を優先する */
export type OnPremisesRole = "primary" | "secondary";

/** VPC CIDR 設定 (単一の Private Subnet を cidrMask で切る VPC) */
export interface VpcCidrConfig {
  /** VPC 全体の CIDR */
  readonly vpcCidr: string;
  /** Private Subnet の cidrMask */
  readonly privateSubnetCidrMask: number;
}

/** Site-to-Site VPN のトンネル内側 CIDR 設定 */
export interface TunnelInsideCidrPair {
  readonly tunnel1: string;
  readonly tunnel2: string;
}

/** リージョンごとの設定 */
export interface RegionConfig {
  /** リージョン名 */
  readonly region: string;
  /** スタック名とタグに使う短縮コード */
  readonly code: string;
  /** Core Network Edge の ASN */
  readonly cneAsn: number;
  /** Transit Gateway の ASN */
  readonly tgwAsn: number;
  /** Cloud WAN に直接アタッチする VPC */
  readonly cloudWanVpc: VpcCidrConfig;
  /** TGW 配下に置く VPC */
  readonly tgwVpc: VpcCidrConfig;
  /** Site-to-Site VPN のトンネル内側 CIDR */
  readonly tunnelInsideCidr: TunnelInsideCidrPair;
  /** 接続するオンプレミス相当ネットワーク */
  readonly onPremisesNetwork: OnPremisesNetworkId;
  /** ペア内での役割。primary のリージョンにオンプレミス相当 VPC を作る */
  readonly onPremisesRole: OnPremisesRole;
}

/**
 * 4 リージョン 2 ペア (jp: 東京/大阪、us: バージニア北部/オレゴン) の設定。
 * 各オンプレミス相当ネットワークとの通信はペアの primary リージョンの TGW を
 * 優先するが、secondary リージョン自身は自リージョンの TGW を使ってよい。
 */
export const REGION_CONFIGS: readonly RegionConfig[] = [
  {
    region: "ap-northeast-1",
    code: "apne1",
    cneAsn: 64520,
    tgwAsn: 64512,
    cloudWanVpc: { vpcCidr: "10.0.0.0/16", privateSubnetCidrMask: 24 },
    tgwVpc: { vpcCidr: "10.10.0.0/16", privateSubnetCidrMask: 24 },
    tunnelInsideCidr: {
      tunnel1: "169.254.10.0/30",
      tunnel2: "169.254.10.4/30",
    },
    onPremisesNetwork: "jp",
    onPremisesRole: "primary",
  },
  {
    region: "ap-northeast-3",
    code: "apne3",
    cneAsn: 64521,
    tgwAsn: 64513,
    cloudWanVpc: { vpcCidr: "10.1.0.0/16", privateSubnetCidrMask: 24 },
    tgwVpc: { vpcCidr: "10.11.0.0/16", privateSubnetCidrMask: 24 },
    tunnelInsideCidr: {
      tunnel1: "169.254.20.0/30",
      tunnel2: "169.254.20.4/30",
    },
    onPremisesNetwork: "jp",
    onPremisesRole: "secondary",
  },
  {
    region: "us-east-1",
    code: "use1",
    cneAsn: 64522,
    tgwAsn: 64514,
    cloudWanVpc: { vpcCidr: "10.2.0.0/16", privateSubnetCidrMask: 24 },
    tgwVpc: { vpcCidr: "10.12.0.0/16", privateSubnetCidrMask: 24 },
    tunnelInsideCidr: {
      tunnel1: "169.254.30.0/30",
      tunnel2: "169.254.30.4/30",
    },
    onPremisesNetwork: "us",
    onPremisesRole: "primary",
  },
  {
    region: "us-west-2",
    code: "usw2",
    cneAsn: 64523,
    tgwAsn: 64515,
    cloudWanVpc: { vpcCidr: "10.3.0.0/16", privateSubnetCidrMask: 24 },
    tgwVpc: { vpcCidr: "10.13.0.0/16", privateSubnetCidrMask: 24 },
    tunnelInsideCidr: {
      tunnel1: "169.254.40.0/30",
      tunnel2: "169.254.40.4/30",
    },
    onPremisesNetwork: "us",
    onPremisesRole: "secondary",
  },
];

/**
 * Core Network Stack (GlobalNetwork / CoreNetwork) を配置するリージョン。
 * jp ペアの primary である apne1 に固定する。`regionConfigOf('jp', 'primary')` ではなく
 * `code` で引く: 将来 jp ペアの primary/secondary が入れ替わっても、Core Network
 * Stack の設置先は運用上 apne1 に固定し続けたいため、role の割り当てからは独立させる
 */
export const CORE_NETWORK_STACK_REGION = (() => {
  const apne1 = REGION_CONFIGS.find((r) => r.code === "apne1");
  if (apne1 === undefined) {
    throw new Error('RegionConfig for code "apne1" not found');
  }
  return apne1.region;
})();

/** オンプレミス相当ネットワークの設定 (Public / Private の 2 Subnet を持つ VPC) */
export interface OnPremisesNetworkConfig {
  /** オンプレミス相当ネットワークの識別子 */
  readonly id: OnPremisesNetworkId;
  /** VPC 全体の CIDR */
  readonly vpcCidr: string;
  /** VPN ルーターの eth0 (Elastic IP) を置く Public Subnet */
  readonly publicSubnetCidr: string;
  /** VPN ルーターの eth1 と疎通確認用 EC2 を置く Private Subnet */
  readonly privateSubnetCidr: string;
  /** オンプレミス相当の VPN ルーター (CustomerGateway) の BGP ASN */
  readonly routerAsn: number;
}

/**
 * オンプレミス相当ネットワークの設定。
 * Cloud WAN にはアタッチしない (アタッチすると AS_PATH 長 1 の経路として全 CNE へ
 * 広報され、各ペアの primary TGW 経由と secondary TGW 経由の比較という実験そのものが
 * 無効化される)。ペアごとに primary リージョン側へ 1 つずつ作る。
 */
export const ON_PREMISES_NETWORKS: Record<
  OnPremisesNetworkId,
  OnPremisesNetworkConfig
> = {
  jp: {
    id: "jp",
    vpcCidr: "10.100.0.0/16",
    publicSubnetCidr: "10.100.0.0/24",
    privateSubnetCidr: "10.100.1.0/24",
    routerAsn: 65000,
  },
  us: {
    id: "us",
    vpcCidr: "10.200.0.0/16",
    publicSubnetCidr: "10.200.0.0/24",
    privateSubnetCidr: "10.200.1.0/24",
    routerAsn: 65001,
  },
};

/** ASN 関連の設定 */
export const ASN = {
  /**
   * Core Network の asn-ranges。CNE の ASN はこの範囲内、
   * TGW / オンプレミスルーター / prepend する ASN はこの範囲外である必要がある
   */
  coreNetworkAsnRange: "64520-64534",
  /**
   * Routing Policy で prepend する ASN のリスト。配列の要素数が prepend する回数 (N) になる。
   * asn-ranges の外、かつ CNE の ASN と重複しない値であること
   * (AS-path のループ検出が inbound ポリシーの評価より先に走るため、
   * CNE の ASN と重複させると prepend が実行される前に経路が drop される)
   */
  prependAsnList: [4200000001],
} as const;

/**
 * Routing Policy の local preference で使う値。
 * `preferred` は優先させたい経路にだけ設定する。既定値 0 を下回る値は使わない
 * (理由は core-network-policy.ts の buildLocalPreferenceRoutingPolicy の JSDoc を参照)
 */
export const LOCAL_PREFERENCE = {
  preferred: 300,
} as const;

/** Cloud WAN の固定値 */
export const CLOUD_WAN = {
  /** アタッチメントを収容する単一セグメントの名前 */
  segmentName: "workload",
  /** セグメント自動割当に使うアタッチメントのタグキー */
  attachmentTagKey: "cloudwan-seg",
  /** Cloud WAN 直アタッチ VPC / TGW 配下 VPC のルートテーブルが Cloud WAN / TGW へ向ける宛先 */
  routeDestinationCidr: "10.0.0.0/8",
} as const;

/**
 * VPN ルーターが 2 リージョンの VPN 接続を検索するためのタグ。
 * VPN Connection ID を Props 経由で渡す方式にすると、片方のスタックの出力を
 * もう片方のスタックが参照する形になり、クロスリージョン参照が循環してしまう。
 * Name タグによる検索であればこの循環を避けられる。値は `vpnNameTagValue` で組み立てる
 */
export const VPN_NAME_TAG = {
  key: "Name",
} as const;

/** `code` から VPN Connection 検索用の Name タグ値を組み立てる */
export const vpnNameTagValue = (code: string): string => `${code}-tgw-vpn`;

/**
 * オンプレミス相当ネットワークの識別子と役割から、該当する RegionConfig を 1 件返す。
 * 該当が無ければ throw する (バリデーションで「ちょうど 1 つずつ存在する」ことを
 * 別途保証しているため、ここに来た時点で該当無しは設定不整合として扱ってよい)
 */
export const regionConfigOf = (
  networkId: OnPremisesNetworkId,
  role: OnPremisesRole
): RegionConfig => {
  const found = REGION_CONFIGS.find(
    (r) => r.onPremisesNetwork === networkId && r.onPremisesRole === role
  );
  if (found === undefined) {
    throw new Error(
      `RegionConfig not found for onPremisesNetwork=${networkId}, onPremisesRole=${role}`
    );
  }
  return found;
};

/**
 * secondary CNE の ASN と、オンプレミス各拠点のルーターの ASN の全組み合わせ。
 * Routing Policy のルール生成に使う。オンプレミス側ルーターの ASN を条件に含めることで、
 * 「secondary CNE を経由した経路」と「secondary CNE 自身が発信した経路」を区別する
 * (前者だけを対象にしたい。詳細は core-network-policy.ts のコメント参照)。
 * secondary はどの拠点宛の経路であっても中継されると同様に望ましくないため、
 * 「自分のペアの拠点だけ」ではなく全拠点との組み合わせを生成する
 */
export const secondaryCneOnPremisesGuardAsns = (): readonly {
  readonly asn: number;
  readonly onPremisesRouterAsn: number;
}[] => {
  const secondaryAsns = REGION_CONFIGS.filter(
    (r) => r.onPremisesRole === "secondary"
  ).map((r) => r.cneAsn);
  const onPremisesRouterAsns = Object.values(ON_PREMISES_NETWORKS).map(
    (n) => n.routerAsn
  );
  return secondaryAsns.flatMap((asn) =>
    onPremisesRouterAsns.map((onPremisesRouterAsn) => ({
      asn,
      onPremisesRouterAsn,
    }))
  );
};

/**
 * primary CNE の ASN と、その primary が属するオンプレミス拠点のルーター ASN の
 * 組み合わせ。`secondaryCneOnPremisesGuardAsns` (secondary × 全拠点の直積) とは
 * 異なり、直積にしない。各 primary は自分のグループの拠点とだけ組にする。
 * 別グループの拠点と組ませる交差項を作ると、他リージョン経由で実際に届いている
 * 経路 (ローカル TGW 経由よりも AS_PATH が長い) まで boost の対象になってしまい、
 * 実害が出ることを実測で確認済みである。詳細は
 * `evidence/20260813/policy2-rib.log` の EDGE=us-west-2 と
 * EDGE=ap-northeast-3 を参照。
 */
export const primaryCneOnPremisesBoostAsns = (): readonly {
  readonly asn: number;
  readonly onPremisesRouterAsn: number;
}[] =>
  REGION_CONFIGS.filter((r) => r.onPremisesRole === "primary").map((r) => ({
    asn: r.cneAsn,
    onPremisesRouterAsn: ON_PREMISES_NETWORKS[r.onPremisesNetwork].routerAsn,
  }));

/** 重複検証の対象になる全 VPC CIDR (Cloud WAN 直アタッチ VPC + TGW 配下 VPC + オンプレミス相当 VPC) */
export const allVpcCidrs = (): readonly string[] => [
  ...REGION_CONFIGS.map((r) => r.cloudWanVpc.vpcCidr),
  ...REGION_CONFIGS.map((r) => r.tgwVpc.vpcCidr),
  ...Object.values(ON_PREMISES_NETWORKS).map((n) => n.vpcCidr),
];

/** 重複検証の対象になる全トンネル内側 CIDR */
export const allTunnelInsideCidrs = (): readonly string[] =>
  REGION_CONFIGS.flatMap((r) => [
    r.tunnelInsideCidr.tunnel1,
    r.tunnelInsideCidr.tunnel2,
  ]);

/** Routing Policy の適用モード */
export type RoutingPolicyMode = "off" | "prepend" | "localPreference";

/**
 * Routing Policy の適用モード。
 * 切り替えるときはこの値を編集して `cdk deploy CloudWanRoutingCoreStack` を
 * 再実行する (cdk.json の context や `-c` オプションではなくこの定数を正とする方式。
 * 型で候補を絞れ、テストから直接呼べるため)。
 */
export const ROUTING_POLICY_MODE: RoutingPolicyMode = "prepend";

/** prepend 方式の適用範囲 */
export type PrependScope = "minimal" | "withPrimaryFallback" | "all";

/**
 * prepend 方式の適用範囲。切り替えるときはこの値を編集して
 * `cdk deploy CloudWanRoutingCoreStack` を再実行する
 * (`ROUTING_POLICY_MODE` と同じ理由でこの定数を正とする方式にする)。
 *
 * `prepend` の segment-actions は本来 (受信 CNE = X, 送信 CNE = Y、X !== Y) の
 * 全 12 ペアに一律適用する。必要なエントリ数は次の 2 つの事項によって変わり、
 * 2026-08 の実機評価でいずれも確認済みである。
 *
 * - **CNE 間トランジット**: 発生する。ある CNE が他の CNE から学習した経路を、
 *   さらに別の CNE へ再広報していることを `evidence/20260813/` の rib.log で
 *   確認した
 * - **改変の引き継ぎ**: 引き継がれる。他エッジが適用した prepend 済み ASN
 *   `4200000001` が中継先の AS_PATH に乗ったまま観測されたことを同 rib.log で
 *   確認した
 *
 * この 2 事項が確認された結果、後述の判定表を機械的に適用すると
 * `withPrimaryFallback` が必要という結論になる。一方で、通常運用時の実測では、
 * 現在の構成である `minimal` で意図通り secondary の経路が deprioritize
 * されている。加えて、Routing Policy 2 (prepend) と旧 LP 設定を両方適用した
 * 状態で primary (us-east-1) の TGW の Cloud WAN アタッチメントを削除する detach
 * 検証を行ったところ、判定表が想定する症状そのもの、すなわちローカル経路を失った
 * primary を経由する迂回が観測された。
 * `evidence/20260813/policy2-lp-use1-tgw-detach-fib.log` では、apne1 と apne3 の
 * FIB で 10.200.0.0/16 の next-hop が EDGE:us-east-1 のままになっている。
 * 削除したのは us-east-1 の TGW アタッチメントであって CNE 自体ではないため、
 * us-east-1 は 10.200.0.0/16 へのローカル経路を失った状態でメッシュに残り、
 * usw2 から学習した経路を中継し続けている。この観測は LP 設定も同時に適用した
 * 状態のものであり、prepend の
 * `minimal` 単独の挙動を切り分けたものではない。この食い違いを踏まえて
 * `PREPEND_SCOPE` の値を引き上げるべきかは、この訂正とは別に判断する。値そのもの
 * はこの訂正では変更しない。
 *
 * この 2 つを実測で切り分けるため、エントリ数を段階的に増やせるようにする。
 * 3 段階の定義 (いずれも X !== Y):
 *
 * - **`minimal`** (4 ペア): 述語は `Y.onPremisesRole === 'secondary' かつ
 *   X.onPremisesNetwork !== Y.onPremisesNetwork`。CNE 間トランジットが無ければ
 *   これで足りる。primary リージョンは自分のローカル TGW から AS_PATH 長 2 で
 *   経路を受け取るため、リモート CNE 経由 (長さ 3) に prepend 無しで勝つ。
 *   したがってローカル経路を持たない CNE (=対象オンプレミスネットワークの
 *   ペアに属さない CNE) だけがポリシーを必要とする。
 * - **`withPrimaryFallback`** (6 ペア): 述語は `Y.onPremisesRole === 'secondary'`
 *   のみ (`minimal` の 4 ペア + 同じペアの primary が受け取る分 2 ペア)。
 *   トランジットがあり、かつ改変後の AS_PATH が再広報で引き継がれる場合に必要。
 *   primary の VPN が断のとき、primary は secondary から学習した経路を他 CNE へ
 *   再広報する。primary 側で先に prepend しておかないと、下流で「secondary 直」と
 *   「primary 経由」が同じ AS_PATH 長になって経路選択が不定に戻ってしまう。
 * - **`all`** (12 ペア): 述語は常に true。トランジットがあり、かつ改変が
 *   再広報で引き継がれない場合に必要。改変が引き継がれない以上、受信側の
 *   CNE ごとに個別に判定するしかない。
 *
 * 実験手順: `minimal` から始めて primary の VPN 接続を落とし、ローカル経路を
 * 持たない CNE の FIB (`get-network-routes`) を確認する。効果確認は必ず FIB で
 * 行う。RIB は、クエリ対象のエッジ自身がこれから適用する分については適用前の
 * 情報を返すが、他エッジが中継前に既に適用した改変は RIB にも反映される。
 * この区別自体は AWS ドキュメントに明記が無く、実データから逆算した推論である。
 * secondary 直の経路に決まればトランジット無しで確定。primary 経由と同点なら
 * `withPrimaryFallback` に上げて再測定する。AS_PATH 長と MED が等しい場合は
 * タイブレークで不定になる。AWS の Route evaluation ページに
 * 「a single attachment will be chosen in a deterministically random manner」
 * とある
 * (https://docs.aws.amazon.com/network-manager/latest/cloudwan/cloudwan-route-evaluation.html)。
 * それでも解決しなければ `all` に上げる。
 */
export const PREPEND_SCOPE: PrependScope = "minimal";

/**
 * (受信 CNE, 送信 CNE) のペア。segment-actions の edge-location / peer-edge-location
 * に対応する。`prependScopePairs` と `localPreferenceBoostPairs` の両方が返す共通の形
 */
export interface PrependPair {
  /** 受信 CNE (edge-location)。X */
  readonly edge: RegionConfig;
  /** 送信 CNE (peer-edge-location)。Y */
  readonly peer: RegionConfig;
}

/**
 * `PrependScope` ごとの (受信 CNE, 送信 CNE) ペア採用述語。
 * 定義の根拠は `PrependScope` の JSDoc を参照
 */
const PREPEND_SCOPE_PREDICATES: Record<
  PrependScope,
  (pair: PrependPair) => boolean
> = {
  minimal: ({ edge, peer }) =>
    peer.onPremisesRole === "secondary" &&
    edge.onPremisesNetwork !== peer.onPremisesNetwork,
  withPrimaryFallback: ({ peer }) => peer.onPremisesRole === "secondary",
  all: () => true,
};

/**
 * 指定した `PrependScope` で採用される (受信 CNE, 送信 CNE) ペアの一覧を返す。
 * `REGION_CONFIGS` の全 (edge, peer) 直積 (edge !== peer) をスコープの述語で絞り込む
 */
export const prependScopePairs = (
  scope: PrependScope
): readonly PrependPair[] =>
  REGION_CONFIGS.flatMap((edge) =>
    REGION_CONFIGS.filter((peer) => peer.region !== edge.region).map(
      (peer): PrependPair => ({ edge, peer })
    )
  ).filter((pair) => PREPEND_SCOPE_PREDICATES[scope](pair));

/**
 * boost 方式で local preference を優先させる (edge, peer) ペアの一覧。
 * 述語は「peer が primary CNE であり、かつ edge が peer と別のオンプレミス
 * グループに属する」。`prependScopePairs` と構造は同じだが、boost 方式に
 * 正しい絞り込みはこの 1 つしかないため `PrependScope` のような enum は作らない。
 * 絞り込みが必要な理由は `buildSegmentActionsForLocalPreferenceBoost` の
 * JSDoc を参照
 */
export const localPreferenceBoostPairs = (): readonly PrependPair[] =>
  REGION_CONFIGS.flatMap((edge) =>
    REGION_CONFIGS.filter((peer) => peer.region !== edge.region).map(
      (peer): PrependPair => ({ edge, peer })
    )
  ).filter(
    ({ edge, peer }) =>
      peer.onPremisesRole === "primary" &&
      edge.onPremisesNetwork !== peer.onPremisesNetwork
  );

/** CIDR 文字列を [開始アドレス, 終了アドレス] の 32bit 整数範囲に変換する */
export const cidrToRange = (cidr: string): readonly [number, number] => {
  const [ip, prefixStr] = cidr.split("/");
  const base = ip.split(".").reduce((acc, oct) => acc * 256 + Number(oct), 0);
  const size = 2 ** (32 - Number(prefixStr));
  return [base, base + size - 1];
};

/**
 * CIDR の配列に範囲の重複が無いことを検証する (包含関係も検出する)。
 * 異常時は throw する。エラーメッセージは英語。
 */
export const assertNoOverlappingCidrs = (
  cidrs: readonly string[],
  label: string
): void => {
  const overlaps = cidrs.flatMap((a, i) =>
    cidrs
      .slice(i + 1)
      .filter((b) => {
        const [aStart, aEnd] = cidrToRange(a);
        const [bStart, bEnd] = cidrToRange(b);
        return aStart <= bEnd && bStart <= aEnd;
      })
      .map((b) => `${a} <-> ${b}`)
  );
  if (overlaps.length > 0) {
    throw new Error(
      `${label}: overlapping CIDR ranges found: ${overlaps.join(", ")}`
    );
  }
};

/** ASN の範囲文字列 ("64520-64534") を [開始, 終了] の数値タプルに変換する */
const parseAsnRange = (range: string): readonly [number, number] => {
  const [start, end] = range.split("-").map(Number);
  return [start, end];
};

/** ASN が指定した asn-ranges の範囲内であることを検証する。異常時は throw する */
export const assertAsnWithinRange = (
  asn: number,
  range: string,
  label: string
): void => {
  const [start, end] = parseAsnRange(range);
  if (asn < start || asn > end) {
    throw new Error(
      `${label}: ASN ${asn} must be within asn-ranges (${range})`
    );
  }
};

/** ASN が指定した asn-ranges の範囲外であることを検証する。異常時は throw する */
export const assertAsnOutsideRange = (
  asn: number,
  range: string,
  label: string
): void => {
  const [start, end] = parseAsnRange(range);
  if (asn >= start && asn <= end) {
    throw new Error(
      `${label}: ASN ${asn} must be outside asn-ranges (${range})`
    );
  }
};

/** ASN が指定した ASN の集合と重複しないことを検証する。異常時は throw する */
export const assertAsnDoesNotOverlap = (
  asn: number,
  others: readonly number[],
  label: string
): void => {
  if (others.includes(asn)) {
    throw new Error(
      `${label}: ASN ${asn} must not overlap with any of ${others.join(", ")}`
    );
  }
};

/** 全 VPC CIDR に範囲の重複が無いことを検証する (synth 時に呼ぶ) */
export const validateVpcCidrsDoNotOverlap = (): void =>
  assertNoOverlappingCidrs(allVpcCidrs(), "VPC CIDR");

/** 全トンネル内側 CIDR に重複が無いことを検証する (synth 時に呼ぶ) */
export const validateTunnelInsideCidrsDoNotOverlap = (): void =>
  assertNoOverlappingCidrs(allTunnelInsideCidrs(), "Tunnel inside CIDR");

/** 各 CNE の ASN が asn-ranges の範囲内であることを検証する (synth 時に呼ぶ) */
export const validateCneAsnsWithinAsnRanges = (): void => {
  REGION_CONFIGS.forEach((r) =>
    assertAsnWithinRange(
      r.cneAsn,
      ASN.coreNetworkAsnRange,
      `CNE ASN (${r.code})`
    )
  );
};

/**
 * 各 TGW の ASN が asn-ranges の範囲外であることを検証する (synth 時に呼ぶ)。
 * Cloud WAN と TGW は eBGP で peering するため ASN が重複してはいけない
 */
export const validateTgwAsnsOutsideAsnRanges = (): void => {
  REGION_CONFIGS.forEach((r) =>
    assertAsnOutsideRange(
      r.tgwAsn,
      ASN.coreNetworkAsnRange,
      `TGW ASN (${r.code})`
    )
  );
};

/** オンプレミスルーターの ASN が asn-ranges の範囲外であることを検証する (synth 時に呼ぶ) */
export const validateOnPremisesRouterAsnOutsideAsnRanges = (): void => {
  Object.values(ON_PREMISES_NETWORKS).forEach((n) =>
    assertAsnOutsideRange(
      n.routerAsn,
      ASN.coreNetworkAsnRange,
      `On-premises router ASN (${n.id})`
    )
  );
};

/** prepend する ASN が asn-ranges の範囲外であることを検証する (synth 時に呼ぶ) */
export const validatePrependAsnsOutsideAsnRanges = (): void => {
  ASN.prependAsnList.forEach((asn) =>
    assertAsnOutsideRange(asn, ASN.coreNetworkAsnRange, "Prepend ASN")
  );
};

/**
 * prepend する ASN が CNE の ASN と重複しないことを検証する (synth 時に呼ぶ)。
 * AS-path のループ検出が inbound ポリシーの評価より先に走るため、重複すると
 * prepend が実行される前に経路が drop される
 */
export const validatePrependAsnsDoNotOverlapCneAsns = (): void => {
  const cneAsns = REGION_CONFIGS.map((r) => r.cneAsn);
  ASN.prependAsnList.forEach((asn) =>
    assertAsnDoesNotOverlap(asn, cneAsns, "Prepend ASN")
  );
};

/**
 * 各オンプレミス相当ネットワークについて、`REGION_CONFIGS` の中に primary と
 * secondary がちょうど 1 つずつ存在することを検証する (synth 時に呼ぶ)。
 * 0 個 (どのリージョンにも割り当てられていない) と 2 個以上 (優先すべき primary が
 * 曖昧になる) のどちらも、オンプレミス経路をどの TGW に寄せるかという設計の前提を
 * 崩すため throw する。`ON_PREMISES_NETWORKS` の key を正とする
 * (`REGION_CONFIGS` から集めると、割り当てが 0 件のネットワークを見落とす)
 */
export const validateOnPremisesNetworkRolesAreUnique = (): void => {
  (Object.keys(ON_PREMISES_NETWORKS) as OnPremisesNetworkId[]).forEach(
    (networkId) => {
      (["primary", "secondary"] as const).forEach((role) => {
        const matched = REGION_CONFIGS.filter(
          (r) => r.onPremisesNetwork === networkId && r.onPremisesRole === role
        );
        if (matched.length !== 1) {
          throw new Error(
            `OnPremisesNetwork (${networkId}): expected exactly one region with role "${role}", found ${matched.length}`
          );
        }
      });
    }
  );
};

/** デプロイ範囲 */
export type DeploymentScope = "vpnOnly" | "full";

/**
 * デプロイ範囲。切り替えるときはこの値を編集して `cdk deploy --all` を再実行する
 * (`ROUTING_POLICY_MODE` と同じ理由でこの定数を正とする方式にする)。
 *
 * `vpnOnly` は Cloud WAN 一式 (`CoreNetworkStack`) を作らず、
 * `VPN_ONLY_TARGET_NETWORK` が示すペアの TGW + Site-to-Site VPN だけを
 * デプロイするモード。Cloud WAN のアタッチメントは削除に時間がかかり
 * (Core Network のポリシーバージョン適用と絡むため試行錯誤の回転が悪い)、
 * 最もリスクの高い箇所 (1 台の VPN ルーターに 4 本の IPsec トンネルを
 * 同居させられるか) をデプロイ前に切り分けたい場合はこちらを使う。
 *
 * `vpnOnly` で確認できること:
 *
 * - 1 台のルーターで 4 トンネルが UP になるか (最大のリスク)
 * - BGP セッションが 4 本 Established になるか
 * - ブートストラップスクリプトが 2 リージョンの VPN 接続をタグで
 *   見つけられるか
 * - TGW 配下 VPC からオンプレミス相当の疎通確認用 EC2 へ ping が通るか
 *
 * `vpnOnly` で確認できないこと:
 *
 * - Cloud WAN を作らないため CNE 間の経路選択と Routing Policy の効果は
 *   測れない。**`ROUTING_POLICY_MODE` と `PREPEND_SCOPE` は `vpnOnly` では
 *   一切効かない**
 * - `set-return-path.sh` の best path 切り替えは測れない。VPN ルーターが
 *   受け取るのは apne1 TGW からの 10.10.0.0/16 と apne3 TGW からの
 *   10.11.0.0/16 で別プレフィックスなので競合しない。同一プレフィックスが
 *   両 TGW から届く状況は Cloud WAN が経路を配って初めて成立する
 * - `fail-primary-vpn.sh` のフェイルオーバー効果も測れない。代替経路が
 *   無いため、経路が消えることまでしか確認できない
 */
export const DEPLOYMENT_SCOPE: DeploymentScope = "full";

/** `vpnOnly` のときにデプロイするペア。そのペアの primary と secondary の 2 リージョンだけを作る */
export const VPN_ONLY_TARGET_NETWORK: OnPremisesNetworkId = "jp";

/**
 * ネットワーク設定全体の整合性を検証する。
 * bin から synth の前に呼び、異常値があれば例外で止める。
 */
export const validateNetworkConfig = (): void => {
  validateVpcCidrsDoNotOverlap();
  validateTunnelInsideCidrsDoNotOverlap();
  validateCneAsnsWithinAsnRanges();
  validateTgwAsnsOutsideAsnRanges();
  validateOnPremisesRouterAsnOutsideAsnRanges();
  validatePrependAsnsOutsideAsnRanges();
  validatePrependAsnsDoNotOverlapCneAsns();
  validateOnPremisesNetworkRolesAreUnique();
};
