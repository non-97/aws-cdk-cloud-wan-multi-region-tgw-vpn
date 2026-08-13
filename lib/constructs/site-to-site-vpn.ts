import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface SiteToSiteVpnProps {
  /** アタッチ先の Transit Gateway ID */
  readonly transitGatewayId: string;
  /** VPN アタッチメントを association / propagation する TGW Route Table ID */
  readonly routeTableId: string;
  /** VPN ルーター (Customer Gateway) の Elastic IP */
  readonly customerGatewayIp: string;
  /** Customer Gateway 側 BGP ASN */
  readonly cgwBgpAsn: number;
  /** Tunnel 1 inside CIDR (/30) */
  readonly tunnel1InsideCidr: string;
  /** Tunnel 2 inside CIDR (/30) */
  readonly tunnel2InsideCidr: string;
  /** VPN Connection に付与する Name タグのキー */
  readonly nameTagKey: string;
  /** VPN Connection に付与する Name タグの値 */
  readonly nameTagValue: string;
}

export class SiteToSiteVpn extends Construct {
  public readonly vpnConnectionId: string;

  constructor(scope: Construct, id: string, props: SiteToSiteVpnProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    const cgw = new ec2.CfnCustomerGateway(this, 'CustomerGateway', {
      type: 'ipsec.1',
      bgpAsn: props.cgwBgpAsn,
      ipAddress: props.customerGatewayIp,
    });

    const vpnActivityLogGroup = new logs.LogGroup(this, 'VpnActivityLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const vpnBgpLogGroup = new logs.LogGroup(this, 'VpnBgpLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const tunnelOptions = {
      ikeVersions: [{ value: 'ikev2' }],
      phase1EncryptionAlgorithms: [
        { value: 'AES256' },
        { value: 'AES128-GCM-16' },
        { value: 'AES256-GCM-16' },
      ],
      phase1IntegrityAlgorithms: [
        { value: 'SHA2-256' },
        { value: 'SHA2-384' },
        { value: 'SHA2-512' },
      ],
      phase1DhGroupNumbers: [
        { value: 14 },
        { value: 15 },
        { value: 16 },
        { value: 19 },
        { value: 20 },
        { value: 21 },
        { value: 22 },
        { value: 23 },
        { value: 24 },
      ],
      phase2EncryptionAlgorithms: [
        { value: 'AES256' },
        { value: 'AES128-GCM-16' },
        { value: 'AES256-GCM-16' },
      ],
      phase2IntegrityAlgorithms: [
        { value: 'SHA2-256' },
        { value: 'SHA2-384' },
        { value: 'SHA2-512' },
      ],
      phase2DhGroupNumbers: [
        { value: 14 },
        { value: 15 },
        { value: 16 },
        { value: 19 },
        { value: 20 },
        { value: 21 },
        { value: 22 },
        { value: 23 },
        { value: 24 },
      ],
      dpdTimeoutAction: 'clear',
      startupAction: 'add',
      logOptions: {
        cloudwatchLogOptions: {
          logEnabled: true,
          logGroupArn: cdk.Arn.format(
            {
              service: 'logs',
              resource: 'log-group',
              resourceName: vpnActivityLogGroup.logGroupName,
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            },
            stack,
          ),
          logOutputFormat: 'json',
          bgpLogEnabled: true,
          bgpLogGroupArn: cdk.Arn.format(
            {
              service: 'logs',
              resource: 'log-group',
              resourceName: vpnBgpLogGroup.logGroupName,
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            },
            stack,
          ),
          bgpLogOutputFormat: 'json',
        },
      },
    };

    const vpnConnection = new ec2.CfnVPNConnection(this, 'VpnConnection', {
      type: 'ipsec.1',
      staticRoutesOnly: false,
      customerGatewayId: cgw.ref,
      transitGatewayId: props.transitGatewayId,
      // preSharedKey はあえて指定しない。事前共有鍵をコードに書かないことで
      // リポジトリに機密情報を残さず、AWS 側の自動採番に任せる。
      // VPN ルーター側は起動時に describe-vpn-connections を呼び、
      // レスポンスに含まれる事前共有鍵を取得して IPsec 設定に反映する。
      vpnTunnelOptionsSpecifications: [
        {
          tunnelInsideCidr: props.tunnel1InsideCidr,
          ...tunnelOptions,
        },
        {
          tunnelInsideCidr: props.tunnel2InsideCidr,
          ...tunnelOptions,
        },
      ],
      // Name タグを付ける理由: VPN ルーターは東京・大阪の 2 リージョンに
      // またがる VPN 接続をこの Name タグで検索する。VPN Connection ID を
      // Props 経由で渡す方式にすると、東京スタックの出力を大阪スタックが
      // 参照し、大阪スタックの出力を東京スタックが参照する形になり、
      // クロスリージョン参照が循環してしまう。Name タグによる検索であれば
      // スタック間の値の受け渡しが不要になり、この循環を避けられる。
      tags: [{ key: props.nameTagKey, value: props.nameTagValue }],
    });

    // CfnVPNConnection は Transit Gateway attachment の ID を返さないため、
    // AwsCustomResource で describeTransitGatewayAttachments を呼んで
    // attachment ID を取得する。
    const describeVpnAttachment = new AwsCustomResource(
      this,
      'DescribeVpnAttachment',
      {
        onCreate: {
          service: 'EC2',
          action: 'describeTransitGatewayAttachments',
          parameters: {
            Filters: [
              { Name: 'resource-id', Values: [vpnConnection.ref] },
              { Name: 'resource-type', Values: ['vpn'] },
            ],
          },
          physicalResourceId: PhysicalResourceId.of(vpnConnection.ref),
        },
        onUpdate: {
          service: 'EC2',
          action: 'describeTransitGatewayAttachments',
          parameters: {
            Filters: [
              { Name: 'resource-id', Values: [vpnConnection.ref] },
              { Name: 'resource-type', Values: ['vpn'] },
            ],
          },
          physicalResourceId: PhysicalResourceId.of(vpnConnection.ref),
        },
        policy: AwsCustomResourcePolicy.fromSdkCalls({
          resources: AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      },
    );
    describeVpnAttachment.node.addDependency(vpnConnection);

    const vpnAttachmentId = describeVpnAttachment.getResponseField(
      'TransitGatewayAttachments.0.TransitGatewayAttachmentId',
    );

    new ec2.CfnTransitGatewayRouteTableAssociation(this, 'VpnTgwRtAssociation', {
      transitGatewayRouteTableId: props.routeTableId,
      transitGatewayAttachmentId: vpnAttachmentId,
    });

    new ec2.CfnTransitGatewayRouteTablePropagation(this, 'VpnTgwRtPropagation', {
      transitGatewayRouteTableId: props.routeTableId,
      transitGatewayAttachmentId: vpnAttachmentId,
    });

    this.vpnConnectionId = vpnConnection.ref;
  }
}
