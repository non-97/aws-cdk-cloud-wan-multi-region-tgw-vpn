import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as networkmanager from 'aws-cdk-lib/aws-networkmanager';
import { Construct } from 'constructs';
import { CLOUD_WAN } from '../network-config';

/** VPC の attach 先 (Cloud WAN 直アタッチ / TGW 配下) */
export type VpcAttachmentTarget =
  | {
      readonly kind: 'cloudWan';
      readonly coreNetworkId: string;
      readonly coreNetworkArn: string;
      readonly segmentTag: string;
    }
  | {
      readonly kind: 'tgw';
      readonly transitGatewayId: string;
      readonly routeTableId: string;
    };

export interface PrivateVpcProps {
  /** VPC CIDR ブロック */
  readonly vpcCidr: string;
  /** VPC の attach 先 (Cloud WAN 直アタッチ / TGW 配下) */
  readonly attachment: VpcAttachmentTarget;
  /**
   * Private / Attachment サブネットの CIDR マスク長。
   *
   * @default 24
   */
  readonly subnetCidrMask?: number;
}

/**
 * Cloud WAN 直アタッチ VPC と TGW 配下 VPC の両方を扱う Construct。
 *
 * 疎通確認用 EC2 を Private サブネットに置き、Attachment サブネットで
 * Cloud WAN / TGW にアタッチする。Private サブネットは Public Subnet として
 * 構成し、Internet Gateway 経由のデフォルトルートに加えて検証対象の集約 CIDR
 * (`CLOUD_WAN.routeDestinationCidr`) 宛のルートを追加する。疎通確認用 EC2 への
 * 接続は EC2 Instance Connect Endpoint ではなく SSM Session Manager を使う
 * (アカウント / リージョンあたり 5 個の EIC hard quota を消費しないため)。
 */
export class PrivateVpc extends Construct {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: PrivateVpcProps) {
    super(scope, id);

    const subnetCidrMask = props.subnetCidrMask ?? 24;

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: 1,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PUBLIC,
          mapPublicIpOnLaunch: true,
          cidrMask: subnetCidrMask,
        },
        {
          name: 'Attachment',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: subnetCidrMask,
        },
      ],
    });
    this.vpc = vpc;

    const privateSubnet = vpc.selectSubnets({ subnetGroupName: 'Private' })
      .subnets[0];
    const attachmentSubnet = vpc.selectSubnets({
      subnetGroupName: 'Attachment',
    }).subnets[0];

    // 検証対象の集約 CIDR (Cloud WAN / TGW 側から見た広報元) からのみ
    // 疎通確認用 EC2 への通信を許可する。
    const ec2Sg = new ec2.SecurityGroup(this, 'Ec2Sg', {
      vpc,
      description: 'for EC2 instance',
    });
    ec2Sg.addIngressRule(
      ec2.Peer.ipv4(CLOUD_WAN.routeDestinationCidr),
      ec2.Port.allTraffic(),
    );

    new ec2.Instance(this, 'Instance', {
      vpc,
      vpcSubnets: { subnets: [privateSubnet] },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO,
      ),
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64',
      ),
      securityGroup: ec2Sg,
      ssmSessionPermissions: true,
    });

    if (props.attachment.kind === 'cloudWan') {
      const cloudWan = props.attachment;
      const vpcAttachment = new networkmanager.CfnVpcAttachment(
        this,
        'CloudWanAttachment',
        {
          coreNetworkId: cloudWan.coreNetworkId,
          vpcArn: vpc.vpcArn,
          subnetArns: [
            cdk.Arn.format(
              {
                service: 'ec2',
                resource: 'subnet',
                resourceName: attachmentSubnet.subnetId,
              },
              cdk.Stack.of(this),
            ),
          ],
          tags: [
            { key: CLOUD_WAN.attachmentTagKey, value: cloudWan.segmentTag },
          ],
        },
      );

      const route = new ec2.CfnRoute(this, 'PrivateSubnetRoute', {
        routeTableId: privateSubnet.routeTable.routeTableId,
        destinationCidrBlock: CLOUD_WAN.routeDestinationCidr,
        coreNetworkArn: cloudWan.coreNetworkArn,
      });
      // ルートは VPC アタッチメントが確立してから追加する必要があるため、
      // 明示的に依存関係を張る。
      route.addResourceDependency(vpcAttachment);
    } else {
      const tgw = props.attachment;
      const tgwAttachment = new ec2.CfnTransitGatewayVpcAttachment(
        this,
        'TgwAttachment',
        {
          transitGatewayId: tgw.transitGatewayId,
          vpcId: vpc.vpcId,
          subnetIds: [attachmentSubnet.subnetId],
        },
      );

      new ec2.CfnTransitGatewayRouteTableAssociation(
        this,
        'TgwRtAssociation',
        {
          transitGatewayRouteTableId: tgw.routeTableId,
          transitGatewayAttachmentId: tgwAttachment.attrId,
        },
      );

      new ec2.CfnTransitGatewayRouteTablePropagation(
        this,
        'TgwRtPropagation',
        {
          transitGatewayRouteTableId: tgw.routeTableId,
          transitGatewayAttachmentId: tgwAttachment.attrId,
        },
      );

      const route = new ec2.CfnRoute(this, 'PrivateSubnetRoute', {
        routeTableId: privateSubnet.routeTable.routeTableId,
        destinationCidrBlock: CLOUD_WAN.routeDestinationCidr,
        transitGatewayId: tgw.transitGatewayId,
      });
      // ルートは TGW アタッチメントが確立してから追加する必要があるため、
      // 明示的に依存関係を張る。
      route.addResourceDependency(tgwAttachment);
    }
  }
}
