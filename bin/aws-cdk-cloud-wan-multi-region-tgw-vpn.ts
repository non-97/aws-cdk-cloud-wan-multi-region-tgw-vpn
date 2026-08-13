#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { CoreNetworkStack } from '../lib/core-network-stack';
import { RegionStack } from '../lib/region-stack';
import type { RegionStackCloudWan } from '../lib/region-stack';
import { DashboardStack } from '../lib/dashboard-stack';
import {
  CORE_NETWORK_STACK_REGION,
  DEPLOYMENT_SCOPE,
  REGION_CONFIGS,
  VPN_ONLY_TARGET_NETWORK,
  validateNetworkConfig,
} from '../lib/network-config';
import type { OnPremisesNetworkId, RegionConfig } from '../lib/network-config';

/**
 * デプロイ先のアカウント ID を、CDK CLI が現在の認証情報から渡す
 * CDK_DEFAULT_ACCOUNT から解決する。固定値をコードに書かないのは、
 * プロファイルを切り替えたときに実際のデプロイ先と食い違う事故を防ぐため。
 *
 * 未設定のまま進むと env が環境非依存になり、`crossRegionReferences` が
 * 「環境非依存のスタックでは使えない」という原因の分かりにくいエラーで落ちる。
 * ここで明示的に止めて、認証を通すよう促す。
 */
const resolveAccountId = (): string => {
  const account = process.env.CDK_DEFAULT_ACCOUNT;
  if (account === undefined || account === '') {
    throw new Error(
      'CDK_DEFAULT_ACCOUNT is not set. Run `awsume <profile>` and verify with `aws sts get-caller-identity` before running the CDK CLI.',
    );
  }
  return account;
};

// synth の前に CIDR / ASN の整合性を検証する (異常値があれば例外で止める)
validateNetworkConfig();

const accountId = resolveAccountId();

const app = new cdk.App();

// `DEPLOYMENT_SCOPE === 'full'` のときのみ CoreNetworkStack (GlobalNetwork /
// CoreNetwork) を作る。`vpnOnly` は Cloud WAN 一式を作らずに TGW +
// Site-to-Site VPN だけを検証するモードのため、CoreNetworkStack 自体が不要になる。
const coreNetworkStack: CoreNetworkStack | undefined =
  DEPLOYMENT_SCOPE === 'full'
    ? new CoreNetworkStack(app, 'CloudWanRoutingCoreStack', {
        env: {
          account: accountId,
          region: CORE_NETWORK_STACK_REGION,
        },
        // 各 RegionStack が CoreNetwork の ID / ARN をクロスリージョンで参照するため有効にする
        crossRegionReferences: true,
      })
    : undefined;

// RegionStack に渡す Cloud WAN 接続設定。CoreNetworkStack が無ければ無効として渡す。
const cloudWan: RegionStackCloudWan =
  coreNetworkStack === undefined
    ? { enabled: false }
    : {
        enabled: true,
        coreNetworkId: coreNetworkStack.coreNetworkId,
        coreNetworkArn: coreNetworkStack.coreNetworkArn,
        globalNetworkId: coreNetworkStack.globalNetworkId,
      };

// `vpnOnly` のときは `VPN_ONLY_TARGET_NETWORK` が示すペアの 2 リージョンだけを対象にする。
const targetRegionConfigs =
  DEPLOYMENT_SCOPE === 'full'
    ? REGION_CONFIGS
    : REGION_CONFIGS.filter(
        (regionConfig) => regionConfig.onPremisesNetwork === VPN_ONLY_TARGET_NETWORK,
      );

// DashboardStack (TGW Flow Logs 一覧) へ渡すため、作った RegionStack を
// regionConfig と対にして集める。
const allRegionStacks: { regionConfig: RegionConfig; regionStack: RegionStack }[] = [];

// primary リージョンを先に作り、オンプレミス相当ネットワークの識別子をキーにした
// Map に集める。secondary の CustomerGateway が primary の VPN ルーターの
// Elastic IP を参照するため、secondary を作る際に primary の RegionStack を
// 引けるようにしておく必要がある。
const primaryRegionStacks = targetRegionConfigs
  .filter((regionConfig) => regionConfig.onPremisesRole === 'primary')
  .reduce((stacks, regionConfig) => {
    const regionStack = new RegionStack(
      app,
      `CloudWanRoutingRegionStack-${regionConfig.code}`,
      {
        env: { account: accountId, region: regionConfig.region },
        regionConfig,
        cloudWan,
        crossRegionReferences: true,
      },
    );
    // Core Network が先に存在している必要がある (`vpnOnly` では作らないため不要)
    if (coreNetworkStack !== undefined) {
      regionStack.addStackDependency(coreNetworkStack);
    }
    allRegionStacks.push({ regionConfig, regionStack });
    return stacks.set(regionConfig.onPremisesNetwork, regionStack);
  }, new Map<OnPremisesNetworkId, RegionStack>());

// secondary リージョンを続いて作る。
targetRegionConfigs
  .filter((regionConfig) => regionConfig.onPremisesRole === 'secondary')
  .forEach((regionConfig) => {
    const primaryRegionStack = primaryRegionStacks.get(
      regionConfig.onPremisesNetwork,
    );
    if (primaryRegionStack === undefined) {
      throw new Error(
        `Primary RegionStack not found for onPremisesNetwork=${regionConfig.onPremisesNetwork}`,
      );
    }

    const regionStack = new RegionStack(
      app,
      `CloudWanRoutingRegionStack-${regionConfig.code}`,
      {
        env: { account: accountId, region: regionConfig.region },
        regionConfig,
        cloudWan,
        routerElasticIp: primaryRegionStack.routerElasticIp,
        crossRegionReferences: true,
      },
    );
    // Core Network が先に存在している必要がある (`vpnOnly` では作らないため不要)
    if (coreNetworkStack !== undefined) {
      regionStack.addStackDependency(coreNetworkStack);
    }
    // secondary の CustomerGateway が primary の VPN ルーターの Elastic IP を
    // 参照するため、primary のデプロイが完了してからでないと secondary を
    // デプロイできない (2 つを並列にデプロイすることはできない)。
    // `vpnOnly` でもこの依存関係は維持する。
    regionStack.addStackDependency(primaryRegionStack);
    allRegionStacks.push({ regionConfig, regionStack });
  });

// 全リージョンの TGW Flow Logs を一覧表示するダッシュボード。
// リージョンは CORE_NETWORK_STACK_REGION (apne1) に相乗りする。
// ウィジェット自体は LogQueryWidget の `region` プロパティでクロスリージョン表示するため、
// ダッシュボード自体がどのリージョンにあるかは表示内容に影響しない。
const dashboardStack = new DashboardStack(app, 'CloudWanRoutingDashboardStack', {
  env: { account: accountId, region: CORE_NETWORK_STACK_REGION },
  regions: allRegionStacks.map(({ regionConfig, regionStack }) => ({
    regionConfig,
    flowLogGroupName: regionStack.tgwFlowLogGroupName,
  })),
  crossRegionReferences: true,
});
allRegionStacks.forEach(({ regionStack }) =>
  dashboardStack.addStackDependency(regionStack),
);
