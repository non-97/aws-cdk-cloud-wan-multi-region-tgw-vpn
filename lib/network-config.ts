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
 * secondary CNE の ASN と、その secondary が属するオンプレミス拠点のルーター ASN の
 * 組み合わせ。Routing Policy のルール生成に使う。オンプレミス側ルーターの ASN を条件に
 * 含めることで、「secondary CNE を経由した経路」と「secondary CNE 自身が発信した経路」を
 * 区別する (前者だけを対象にしたい。詳細は core-network-policy.ts のコメント参照)。
 *
 * 直積 (secondary × 全拠点) にはしない。かつては全拠点との組み合わせ (交差項を含む4件)
 * を生成していたが、実測で交差項は追跡できたどの経路選択にも影響しないことが確認された。
 * 受信側 CNE は常により短い代替を持っている
 * (自前のローカルリンク、または競合する経路の元になった primary の直接経路のいずれか) ため、
 * 交差項ルールを削除しても結果は変わらない
 * (`evidence/20260813/baseline-rib.log` の `EDGE=us-east-1` の
 * `10.200.0.0/16 via ap-northeast-3`: `64521 64523 64515 65001` で確認。
 * この経路は apne3+US オンプレの交差項にも usw2+US オンプレの自然項にも同時に
 * マッチするが、いずれの場合も use1 自身の直接経路 (長さ3、prepend なし) が
 * 全ての受信側にとって既にこの中継経路より短い。当時の4ルール構成での rule 番号は
 * `evidence/20260813/policy2-corepolicy.json` を参照)。
 * `primaryCneOnPremisesBoostAsns` と同じ形にする
 */
export const secondaryCneOnPremisesGuardAsns = (): readonly {
  readonly asn: number;
  readonly onPremisesRouterAsn: number;
}[] =>
  REGION_CONFIGS.filter((r) => r.onPremisesRole === "secondary").map((r) => ({
    asn: r.cneAsn,
    onPremisesRouterAsn: ON_PREMISES_NETWORKS[r.onPremisesNetwork].routerAsn,
  }));

/**
 * primary CNE の ASN と、その primary が属するオンプレミス拠点のルーター ASN の
 * 組み合わせ。`secondaryCneOnPremisesGuardAsns` と同じく直積にせず、各 primary は
 * 自分のグループの拠点とだけ組にする。別グループの拠点と組ませる交差項を作ると、
 * 他リージョン経由で実際に届いている経路 (ローカル TGW 経由よりも AS_PATH が長い)
 * まで boost の対象になってしまい、実害が出ることを実測で確認済みである。詳細は
 * `evidence/20260813/policy2-rib.log` の EDGE=us-west-2 と
 * EDGE=ap-northeast-3 を参照。
 *
 * `secondaryCneOnPremisesGuardAsns` 側も交差項を持たないが、削除した理由は異なる。
 * 同関数の交差項は「作ると boost のように反転の実害が出るから」ではなく、
 * 「追跡できたどの経路選択にも影響しないことが実測で確認されたから」削除した。
 * 詳細は同関数の JSDoc を参照。両者が結果的に同じ形になったのは偶然であり、
 * 一方の削除理由をもう一方に当てはめてはならない。
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
 *   確認した (`EDGE=us-east-1` の `10.11.0.0/16 via us-west-2`:
 *   `64523 4200000001 64521 64513`)。
 *
 * **既定値は `withPrimaryFallback` を推奨する。** 理由は、`minimal` (4 ペア) が
 * primary の TGW / VPN が落ちるフェイルオーバーで AS_PATH 長のタイを生むためである。
 * 例えばバージニア北部 (use1) の TGW をデタッチした場合、東京 (apne1) から見た
 * 代替は次の2つになり、`prependAsnList` が1要素であるため両者が長さ4で同点になる。
 *
 * - オレゴン (usw2) 直接: `4200000001 64523 64515 65001` (長さ4)
 * - use1 中継 (usw2 発を relay): `64522 64523 64515 65001` (長さ4。
 *   `(use1, peer=usw2)` ペアが `minimal` の対象外のため prepend されない)
 *
 * 同点は AWS の Route evaluation ページが明記する「deterministically random」な
 * タイブレークに委ねられる
 * (https://docs.aws.amazon.com/network-manager/latest/cloudwan/cloudwan-route-evaluation.html)。
 * `withPrimaryFallback` (6 ペア) にすると `(use1, peer=usw2)` が対象に入り、
 * use1 が usw2 から受信する時点で既に prepend が適用され、中継後も引き継がれる
 * (上記の改変の引き継ぎの事実による)。結果、オレゴン直接 (長さ4) と use1 中継
 * (長さ5) の差が1ホップ分確実に生まれ、タイが解消する。
 *
 * **この結論は AS_PATH 長の計算と、上記2つの実機確認済みの事実から導いた設計上の
 * 判断であり、`withPrimaryFallback` + 現行の prepend 実装 + 実際のデタッチという
 * 組み合わせそのものを実機で再検証したものではない。** 2026-08 時点の実測
 * (`evidence/20260813/`) はすべて `minimal` 固定で行っており、`withPrimaryFallback`
 * を実際にデプロイしたデタッチ検証はまだ無い。
 *
 * 3 段階の定義 (いずれも X !== Y):
 *
 * - **`minimal`** (4 ペア): 述語は `Y.onPremisesRole === 'secondary' かつ
 *   X.onPremisesNetwork !== Y.onPremisesNetwork`。primary の VPN / TGW が
 *   健全な間は secondary 経路を deprioritize するだけで足りるが、上記のとおり
 *   primary 側の障害時にタイが生じ得る
 * - **`withPrimaryFallback`** (6 ペア、推奨): 述語は `Y.onPremisesRole === 'secondary'`
 *   のみ (`minimal` の 4 ペア + 同じペアの primary が受け取る分 2 ペア)。
 *   primary の VPN が断のとき、primary は secondary から学習した経路を他 CNE へ
 *   再広報する。primary 側で先に prepend しておくことで、下流で「secondary 直」と
 *   「primary 経由」が同じ AS_PATH 長になる問題を避ける
 * - **`all`** (12 ペア): 述語は常に true。改変の引き継ぎが成立しない場合に備えた
 *   最終手段。上記のとおり引き継ぎは確認済みのため、通常は `withPrimaryFallback`
 *   で足りる
 *
 * `withPrimaryFallback` を実機で再検証する場合は、primary の VPN 接続を落とし、
 * ローカル経路を失った CNE の FIB (`get-network-routes`) で意図通り secondary
 * 側に切り替わるかを確認する。効果確認は必ず FIB で行う。RIB は、クエリ対象の
 * エッジ自身がこれから適用する分については適用前の情報を返すが、他エッジが
 * 中継前に既に適用した改変は RIB にも反映される。この区別自体は AWS ドキュメントに
 * 明記が無く、実データから逆算した推論である。
 */
export const PREPEND_SCOPE: PrependScope = "withPrimaryFallback";

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
