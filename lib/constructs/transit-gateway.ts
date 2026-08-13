import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
  PhysicalResourceIdReference,
} from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/**
 * Transit Gateway Flow Logs のカスタムフォーマット。
 *
 * `packets-lost-no-route` / `packets-lost-blackhole` を含めるのは、疎通確認で
 * 経路が消えた (パケットが届かない) ときに、ドロップ理由が「経路が無い」のか
 * 「経路はあるが blackhole された」のかを切り分けるため。デフォルトフォーマットには
 * この 2 フィールドが含まれず、後から切り分けができなくなる。
 *
 * テンプレートリテラルではなくシングルクォート文字列にする。バッククォートで
 * 書くと `${version}` 等が TypeScript の変数展開として評価され壊れるため。
 */
const TGW_FLOW_LOG_FORMAT =
  '${version} ${resource-type} ${account-id} ${tgw-id} ${tgw-attachment-id} ${tgw-src-vpc-account-id} ${tgw-dst-vpc-account-id} ${tgw-src-vpc-id} ${tgw-dst-vpc-id} ${tgw-src-subnet-id} ${tgw-dst-subnet-id} ${tgw-src-eni} ${tgw-dst-eni} ${tgw-src-az-id} ${tgw-dst-az-id} ${tgw-pair-attachment-id} ${srcaddr} ${dstaddr} ${srcport} ${dstport} ${protocol} ${packets} ${bytes} ${start} ${end} ${log-status} ${type} ${packets-lost-no-route} ${packets-lost-blackhole} ${packets-lost-mtu-exceeded} ${packets-lost-ttl-expired} ${tcp-flags} ${region} ${flow-direction} ${pkt-src-aws-service} ${pkt-dst-aws-service}';

export interface TransitGatewayProps {
  /** TGW Amazon side ASN */
  readonly amazonSideAsn: number;
}

export class TransitGateway extends Construct {
  public readonly transitGateway: ec2.CfnTransitGateway;
  public readonly transitGatewayId: string;
  /**
   * 明示的に作成する TGW Route Table の ID。
   *
   * この Route Table は 1 つしか作らない。Cloud WAN が TGW peering attachment
   * 経由で学習するのは TGW 全体のルートではなく、route table attachment で
   * 紐付けた「この 1 つの Route Table」の中身だけである。もし Site-to-Site VPN
   * アタッチメントと VPC アタッチメントの association / propagation 先を
   * 別々の Route Table に分けてしまうと、Cloud WAN 側にオンプレミス経路が
   * 反映されない。しかもこの設定ミスは CloudFormation のデプロイでも
   * Cloud WAN 側の状態確認でもエラーや警告として現れず、疎通確認して
   * 初めて「リモートリージョン経由になっている (期待した TGW 側のローカル
   * 経路が使われない)」ことに気づく類の罠なので、Route Table は 1 つに
   * 固定し、全アタッチメントをここに集約する。
   */
  public readonly routeTableId: string;
  /**
   * TGW Policy Table ID。
   * AWS::EC2::TransitGatewayPolicyTable は CloudFormation リソースとして
   * 提供されていないため、AwsCustomResource で EC2 API
   * (createTransitGatewayPolicyTable / deleteTransitGatewayPolicyTable) を
   * 直接呼び出して作成・削除する。
   */
  public readonly policyTableId: string;
  /** TGW Flow Logs の CloudWatch Logs ロググループ名。ダッシュボード等の他スタックから参照する */
  public readonly flowLogGroupName: string;

  constructor(scope: Construct, id: string, props: TransitGatewayProps) {
    super(scope, id);

    const tgw = new ec2.CfnTransitGateway(this, 'TransitGateway', {
      amazonSideAsn: props.amazonSideAsn,
      defaultRouteTableAssociation: 'disable',
      defaultRouteTablePropagation: 'disable',
      autoAcceptSharedAttachments: 'disable',
      dnsSupport: 'enable',
      vpnEcmpSupport: 'disable',
      description: 'Transit Gateway',
    });

    const routeTable = new ec2.CfnTransitGatewayRouteTable(this, 'RouteTable', {
      transitGatewayId: tgw.ref,
    });

    const policyTable = new AwsCustomResource(this, 'PolicyTable', {
      onCreate: {
        service: 'EC2',
        action: 'createTransitGatewayPolicyTable',
        parameters: { TransitGatewayId: tgw.ref },
        physicalResourceId: PhysicalResourceId.fromResponse(
          'TransitGatewayPolicyTable.TransitGatewayPolicyTableId',
        ),
      },
      onDelete: {
        service: 'EC2',
        action: 'deleteTransitGatewayPolicyTable',
        parameters: {
          TransitGatewayPolicyTableId: new PhysicalResourceIdReference(),
        },
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    policyTable.node.addDependency(tgw);

    // TGW Flow Logs を CloudWatch Logs へ出力する。既存の Site-to-Site VPN の
    // ログ設定 (retention: ONE_MONTH / removalPolicy: RETAIN) と揃える。
    const flowLogGroup = new logs.LogGroup(this, 'FlowLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const flowLogRole = new iam.Role(this, 'FlowLogDeliveryRole', {
      assumedBy: new iam.ServicePrincipal('vpc-flow-logs.amazonaws.com'),
    });
    // CDK の L2 FlowLog (ec2.FlowLogDestination.toCloudWatchLogs) が付与する
    // 権限と揃える (CreateLogStream / PutLogEvents に加えて DescribeLogStreams)。
    flowLogGroup.grantWrite(flowLogRole);
    flowLogGroup.grant(flowLogRole, 'logs:DescribeLogStreams');

    // Transit Gateway Flow Logs は trafficType (ACCEPT / REJECT のフィルタリング) を
    // サポートしないため指定しない。CfnFlowLogProps.trafficType の JSDoc にも
    // "This parameter is not supported for transit gateway resource types." と
    // 明記されている。ここで使う L1 (ec2.CfnFlowLog) はこの制約を synth 時に
    // 検証しない (検証するのは L2 の ec2.FlowLog のみ) ため、誤って指定しても
    // synth は通ってしまい、デプロイで初めて失敗する類の罠になる。
    //
    // maxAggregationInterval も同種の罠。CfnFlowLogProps.maxAggregationInterval の
    // JSDoc に "This parameter must be 60 seconds for transit gateway resource
    // types." と明記されている一方、既定値は 600 秒であり、L1 はこの制約を
    // synth 時に検証しない。指定を怠ると synth は通ってしまい、デプロイで
    // 初めて失敗する。リージョンが 4 つに増えたため、放置すると 4 スタック
    // 同時にこの失敗を踏むことになる。
    new ec2.CfnFlowLog(this, 'FlowLog', {
      resourceType: 'TransitGateway',
      resourceId: tgw.ref,
      logDestinationType: 'cloud-watch-logs',
      logGroupName: flowLogGroup.logGroupName,
      deliverLogsPermissionArn: flowLogRole.roleArn,
      logFormat: TGW_FLOW_LOG_FORMAT,
      maxAggregationInterval: 60,
    });

    this.transitGateway = tgw;
    this.transitGatewayId = tgw.ref;
    this.routeTableId = routeTable.ref;
    this.policyTableId = policyTable.getResponseField(
      'TransitGatewayPolicyTable.TransitGatewayPolicyTableId',
    );
    this.flowLogGroupName = flowLogGroup.logGroupName;
  }
}
