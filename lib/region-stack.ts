import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import {
  CloudWanTgwPeering,
  OnPremisesVpc,
  PrivateVpc,
  SiteToSiteVpn,
  TransitGateway,
} from './constructs';
import {
  CLOUD_WAN,
  ON_PREMISES_NETWORKS,
  regionConfigOf,
  VPN_NAME_TAG,
  vpnNameTagValue,
} from './network-config';
import type { RegionConfig } from './network-config';

/**
 * Cloud WAN への接続設定。
 *
 * `coreNetworkId` / `coreNetworkArn` / `globalNetworkId` をオプショナルな
 * 3 つのフィールドとして持たせ、実行時チェックで整合性を担保する形にすると、
 * 「`enabled` 相当のフラグは true なのに ID が 1 つ欠けている」状態を型が
 * 許してしまう。判別可能ユニオンにすることで、Cloud WAN を有効にしたのに
 * ID が欠けている状態をコンパイル時に作れなくする。`lib/constructs/private-vpc.ts`
 * の `VpcAttachmentTarget` が既にこの形を採っており、それに倣う。
 */
export type RegionStackCloudWan =
  | {
      readonly enabled: true;
      /** Cloud WAN の Core Network ID */
      readonly coreNetworkId: string;
      /** Cloud WAN の Core Network ARN */
      readonly coreNetworkArn: string;
      /** Cloud WAN の Global Network ID */
      readonly globalNetworkId: string;
    }
  | { readonly enabled: false };

export interface RegionStackProps extends cdk.StackProps {
  /** このリージョンの設定 */
  readonly regionConfig: RegionConfig;
  /**
   * Cloud WAN への接続。無効にすると Cloud WAN 直アタッチ VPC と
   * Cloud WAN-TGW peering を作らない (`vpnOnly` デプロイ範囲で使う)
   */
  readonly cloudWan: RegionStackCloudWan;
  /**
   * primary リージョンの VPN ルーターの Elastic IP。
   * secondary のときのみ指定する
   * @default - primary のときは自身で作るため不要
   */
  readonly routerElasticIp?: string;
}

/**
 * CustomerGateway の IP として使う Elastic IP を決める。
 * primary は自身が作る `OnPremisesVpc` の Elastic IP を、secondary は
 * 同じペアの primary スタックから props 経由で受け取った Elastic IP を使う。
 * secondary なのに未指定の場合、CustomerGateway の IP が欠落したまま synth が
 * 通ってしまう事故につながるため、ここで明示的に throw して synth 時に止める。
 */
const resolveCustomerGatewayIp = (
  regionConfig: RegionConfig,
  primaryRouterElasticIp: string | undefined,
  routerElasticIpProp: string | undefined,
): string => {
  if (primaryRouterElasticIp !== undefined) {
    return primaryRouterElasticIp;
  }
  if (routerElasticIpProp === undefined) {
    throw new Error(
      `RegionStack (${regionConfig.region}): routerElasticIp must be specified for secondary region (onPremisesNetwork=${regionConfig.onPremisesNetwork})`,
    );
  }
  return routerElasticIpProp;
};

/**
 * 各リージョンの検証環境。
 * TGW 配下 VPC / TGW / Site-to-Site VPN を常に持つ。`props.cloudWan.enabled`
 * が true のときのみ、Cloud WAN 直アタッチ VPC と Cloud WAN-TGW peering を
 * 追加で持つ。`onPremisesRole` が primary のリージョンのみオンプレミス相当 VPC
 * (VPN ルーター) を追加で持つ。
 *
 * `cloudWan.enabled` が false のとき (`vpnOnly` デプロイ範囲) の疎通について:
 * TGW 配下 VPC からオンプレミス相当への疎通は Cloud WAN 無しで成立する。
 * TGW のルートテーブルには Site-to-Site VPN が伝播したオンプレミスの経路と
 * TGW 配下 VPC のアタッチメントが同じルートテーブルに association されており、
 * TGW 配下 VPC の Private Subnet は `10.0.0.0/8` を TGW へ向けているため、
 * TGW の中だけで折り返す。
 */
export class RegionStack extends cdk.Stack {
  /** primary のときのみ設定される。同じペアの secondary スタックが参照する */
  public readonly routerElasticIp?: string;
  /** このリージョンの TGW Flow Logs ロググループ名。DashboardStack が参照する */
  public readonly tgwFlowLogGroupName: string;

  constructor(scope: Construct, id: string, props: RegionStackProps) {
    super(scope, id, props);

    const { regionConfig, cloudWan } = props;

    // Cloud WAN 直アタッチ VPC。`vpnOnly` (cloudWan.enabled === false) では
    // 作らない。作らない場合、`PrivateVpc` が VPC ごとに 1 つ持つ
    // EC2 Instance Connect Endpoint もその分減る (Cloud WAN 直アタッチ VPC
    // を作らないぶん apne1 は 3 個から 2 個、apne3 は 2 個から 1 個になる)。
    // これは正しい挙動であり、数が合わないと見て Endpoint を追加しないこと。
    if (cloudWan.enabled) {
      new PrivateVpc(this, 'CloudWanDirectVpc', {
        vpcCidr: regionConfig.cloudWanVpc.vpcCidr,
        subnetCidrMask: regionConfig.cloudWanVpc.privateSubnetCidrMask,
        attachment: {
          kind: 'cloudWan',
          coreNetworkId: cloudWan.coreNetworkId,
          coreNetworkArn: cloudWan.coreNetworkArn,
          segmentTag: CLOUD_WAN.segmentName,
        },
      });
    }

    const transitGateway = new TransitGateway(this, 'TransitGateway', {
      amazonSideAsn: regionConfig.tgwAsn,
    });
    this.tgwFlowLogGroupName = transitGateway.flowLogGroupName;

    // Cloud WAN-TGW peering も同様に `vpnOnly` では作らない。Cloud WAN 自体を
    // 作らないため、peering 先の Core Network / Global Network が存在しない。
    if (cloudWan.enabled) {
      new CloudWanTgwPeering(this, 'CloudWanTgwPeering', {
        coreNetworkId: cloudWan.coreNetworkId,
        globalNetworkId: cloudWan.globalNetworkId,
        transitGatewayId: transitGateway.transitGatewayId,
        transitGatewayRouteTableId: transitGateway.routeTableId,
        policyTableId: transitGateway.policyTableId,
        segmentTag: CLOUD_WAN.segmentName,
      });
    }

    new PrivateVpc(this, 'TgwVpc', {
      vpcCidr: regionConfig.tgwVpc.vpcCidr,
      subnetCidrMask: regionConfig.tgwVpc.privateSubnetCidrMask,
      attachment: {
        kind: 'tgw',
        transitGatewayId: transitGateway.transitGatewayId,
        routeTableId: transitGateway.routeTableId,
      },
    });

    const onPremisesNetworkConfig =
      ON_PREMISES_NETWORKS[regionConfig.onPremisesNetwork];

    const primaryOnPremisesVpc =
      regionConfig.onPremisesRole === 'primary'
        ? (() => {
            const primaryRegionConfig = regionConfigOf(
              regionConfig.onPremisesNetwork,
              'primary',
            );
            const secondaryRegionConfig = regionConfigOf(
              regionConfig.onPremisesNetwork,
              'secondary',
            );

            return new OnPremisesVpc(this, 'OnPremisesVpc', {
              vpcCidr: onPremisesNetworkConfig.vpcCidr,
              routerAsn: onPremisesNetworkConfig.routerAsn,
              // VPN ルーターの bootstrap スクリプト (src/ec2/vpn-router-bootstrap.sh)
              // の規約により、検索順序の 1 番目が primary リージョン、
              // 2 番目が secondary リージョンと決まっている。ここでの並び順を
              // 変えるとブートストラップ側の前提と食い違う。
              vpnSearchRegions: [
                primaryRegionConfig.region,
                secondaryRegionConfig.region,
              ],
              vpnNameTagKey: VPN_NAME_TAG.key,
              vpnNameTagValues: [
                vpnNameTagValue(primaryRegionConfig.code),
                vpnNameTagValue(secondaryRegionConfig.code),
              ],
              // vpnSearchRegions / vpnNameTagValues と同じ順序 (1 番目が
              // primary、2 番目が secondary)。VPN ルーターの FRR 設定の
              // remote-as に使う AWS 側 (Transit Gateway) の BGP ASN。
              awsAsns: [primaryRegionConfig.tgwAsn, secondaryRegionConfig.tgwAsn],
            });
          })()
        : undefined;

    const customerGatewayIp = resolveCustomerGatewayIp(
      regionConfig,
      primaryOnPremisesVpc?.routerElasticIp,
      props.routerElasticIp,
    );

    new SiteToSiteVpn(this, 'SiteToSiteVpn', {
      transitGatewayId: transitGateway.transitGatewayId,
      routeTableId: transitGateway.routeTableId,
      customerGatewayIp,
      cgwBgpAsn: onPremisesNetworkConfig.routerAsn,
      tunnel1InsideCidr: regionConfig.tunnelInsideCidr.tunnel1,
      tunnel2InsideCidr: regionConfig.tunnelInsideCidr.tunnel2,
      nameTagKey: VPN_NAME_TAG.key,
      nameTagValue: vpnNameTagValue(regionConfig.code),
    });

    this.routerElasticIp = primaryOnPremisesVpc?.routerElasticIp;
  }
}
