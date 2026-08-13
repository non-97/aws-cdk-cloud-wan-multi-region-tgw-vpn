import * as cdk from 'aws-cdk-lib/core';
import * as networkmanager from 'aws-cdk-lib/aws-networkmanager';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { CLOUD_WAN } from '../network-config';

export interface CloudWanTgwPeeringProps {
  /** Peering する Cloud WAN の Core Network ID */
  readonly coreNetworkId: string;
  /** TGW を登録する Cloud WAN の Global Network ID */
  readonly globalNetworkId: string;
  /** Peering する Transit Gateway の ID */
  readonly transitGatewayId: string;
  /** セグメントにマップする Transit Gateway Route Table の ID */
  readonly transitGatewayRouteTableId: string;
  /** Transit Gateway の Policy Table ID */
  readonly policyTableId: string;
  /** アタッチメントに付与するセグメントタグの値 */
  readonly segmentTag: string;
}

/**
 * Cloud WAN と Transit Gateway を接続する 4 ステップをまとめる Construct。
 *
 * CloudFormation リソースで完結しない手順 (Policy Table の association) が
 * 途中に挟まるため、東京 / 大阪で同じ手順を重複させずに Construct 化する。
 */
export class CloudWanTgwPeering extends Construct {
  constructor(scope: Construct, id: string, props: CloudWanTgwPeeringProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    const transitGatewayArn = cdk.Arn.format(
      {
        service: 'ec2',
        resource: 'transit-gateway',
        resourceName: props.transitGatewayId,
      },
      stack,
    );

    // 1. TGW を Cloud WAN の Global Network に登録する
    const registration = new networkmanager.CfnTransitGatewayRegistration(
      this,
      'Registration',
      {
        globalNetworkId: props.globalNetworkId,
        transitGatewayArn,
      },
    );

    // 2. Cloud WAN と TGW を peering する
    const peering = new networkmanager.CfnTransitGatewayPeering(
      this,
      'Peering',
      {
        coreNetworkId: props.coreNetworkId,
        transitGatewayArn,
        tags: [{ key: CLOUD_WAN.attachmentTagKey, value: props.segmentTag }],
      },
    );
    peering.node.addDependency(registration);

    // 3. peering attachment に TGW Policy Table を associate する。
    // AWS::EC2::TransitGatewayPolicyTable の association / disassociation は
    // CloudFormation リソースとして提供されていないため、AwsCustomResource で
    // EC2 API を直接呼び出す。
    const associatePolicyTable = new AwsCustomResource(
      this,
      'AssociatePolicyTable',
      {
        onCreate: {
          service: 'EC2',
          action: 'associateTransitGatewayPolicyTable',
          parameters: {
            TransitGatewayPolicyTableId: props.policyTableId,
            TransitGatewayAttachmentId:
              peering.attrTransitGatewayPeeringAttachmentId,
          },
          physicalResourceId: PhysicalResourceId.of(
            peering.attrTransitGatewayPeeringAttachmentId,
          ),
        },
        onDelete: {
          service: 'EC2',
          action: 'disassociateTransitGatewayPolicyTable',
          parameters: {
            TransitGatewayPolicyTableId: props.policyTableId,
            TransitGatewayAttachmentId:
              peering.attrTransitGatewayPeeringAttachmentId,
          },
        },
        policy: AwsCustomResourcePolicy.fromSdkCalls({
          resources: AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      },
    );
    associatePolicyTable.node.addDependency(peering);

    // 4. TGW Route Table をセグメントにマップする。
    // peeringId には attrPeeringId を渡す (attrTransitGatewayPeeringAttachmentId ではない)。
    const routeTableAttachment =
      new networkmanager.CfnTransitGatewayRouteTableAttachment(
        this,
        'RouteTableAttachment',
        {
          peeringId: peering.attrPeeringId,
          transitGatewayRouteTableArn: cdk.Arn.format(
            {
              service: 'ec2',
              resource: 'transit-gateway-route-table',
              resourceName: props.transitGatewayRouteTableId,
            },
            stack,
          ),
          tags: [
            { key: CLOUD_WAN.attachmentTagKey, value: props.segmentTag },
          ],
        },
      );
    routeTableAttachment.node.addDependency(associatePolicyTable);
  }
}
