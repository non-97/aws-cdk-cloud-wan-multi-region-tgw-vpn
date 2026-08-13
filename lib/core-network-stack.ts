import * as cdk from 'aws-cdk-lib/core';
import * as networkmanager from 'aws-cdk-lib/aws-networkmanager';
import { Construct } from 'constructs';
import { buildCoreNetworkPolicy } from './core-network-policy';
import { ROUTING_POLICY_MODE } from './network-config';

/**
 * Cloud WAN の中核 (GlobalNetwork / CoreNetwork) のみを定義する Stack。
 * VPC / TGW / VPN などの Construct は別タスクで追加する (このタスクのスコープ外)。
 *
 * Routing Policy は network-config.ts の ROUTING_POLICY_MODE から生成する。
 * モードを切り替える場合はその定数を編集し、この Stack のみ再デプロイすればよい。
 */
export class CoreNetworkStack extends cdk.Stack {
  /** GlobalNetwork の ID */
  public readonly globalNetworkId: string;
  /** CoreNetwork の ID。TGW / VPC 側の Stack から crossRegionReferences 経由で参照する */
  public readonly coreNetworkId: string;
  /** CoreNetwork の ARN */
  public readonly coreNetworkArn: string;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const globalNetwork = new networkmanager.CfnGlobalNetwork(this, 'GlobalNetwork', {
      description: 'Cloud WAN multi-region access verification global network',
    });

    const coreNetwork = new networkmanager.CfnCoreNetwork(this, 'CoreNetwork', {
      description: 'Cloud WAN multi-region access verification core network',
      globalNetworkId: globalNetwork.attrId,
      policyDocument: buildCoreNetworkPolicy(ROUTING_POLICY_MODE),
    });

    this.globalNetworkId = globalNetwork.attrId;
    this.coreNetworkId = coreNetwork.attrCoreNetworkId;
    this.coreNetworkArn = coreNetwork.attrCoreNetworkArn;
  }
}
