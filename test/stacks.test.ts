import * as fs from 'fs';
import * as path from 'path';
import { App } from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { CoreNetworkStack } from '../lib/core-network-stack';
import { RegionStack } from '../lib/region-stack';
import type { RegionStackCloudWan } from '../lib/region-stack';
import { DashboardStack } from '../lib/dashboard-stack';
import {
  REGION_CONFIGS,
  VPN_NAME_TAG,
  VPN_ONLY_TARGET_NETWORK,
  vpnNameTagValue,
} from '../lib/network-config';

/**
 * cdk.json の context を読み込む。CDK 単体テストは CLI を通さず App を直接
 * 呼ぶため、機能フラグを実デプロイと揃えないとテンプレートに差分が出る。
 */
const getCdkJsonContext = (): Record<string, unknown> => {
  const cdkJsonPath = path.join(__dirname, '..', 'cdk.json');
  const cdkJson = JSON.parse(fs.readFileSync(cdkJsonPath, 'utf-8'));
  return cdkJson.context ?? {};
};

/** バンドル処理をスキップする定型 */
const newApp = () =>
  new App({
    context: { ...getCdkJsonContext(), 'aws:cdk:bundling-stacks': [] },
  });

const CORE_NETWORK_ID = 'core-network-00000000000000000';
const CORE_NETWORK_ARN =
  'arn:aws:networkmanager::123456789012:core-network/core-network-00000000000000000';
const GLOBAL_NETWORK_ID = 'global-network-00000000000000000';
const ROUTER_ELASTIC_IP = '203.0.113.1';

/** `full` デプロイ範囲相当の Cloud WAN 接続設定 (テスト用のダミー ID を使う) */
const FULL_CLOUD_WAN: RegionStackCloudWan = {
  enabled: true,
  coreNetworkId: CORE_NETWORK_ID,
  coreNetworkArn: CORE_NETWORK_ARN,
  globalNetworkId: GLOBAL_NETWORK_ID,
};

/** `vpnOnly` デプロイ範囲相当の Cloud WAN 接続設定 (Cloud WAN 無効) */
const VPN_ONLY_CLOUD_WAN: RegionStackCloudWan = { enabled: false };

describe('CoreNetworkStack', () => {
  const stack = new CoreNetworkStack(newApp(), 'CoreNetworkStack', {});
  const template = Template.fromStack(stack);

  test('snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});

describe('DashboardStack', () => {
  // 実際の RegionStack は組み立てず、プレーンなダミー値を渡す
  // (DashboardStackProps が RegionStack に依存しない設計のため)。
  const stack = new DashboardStack(newApp(), 'DashboardStack', {
    regions: REGION_CONFIGS.map((regionConfig) => ({
      regionConfig,
      flowLogGroupName: `dummy-log-group-${regionConfig.code}`,
    })),
  });
  const template = Template.fromStack(stack);

  test('snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});

// `full` (Cloud WAN 有効) の RegionStack テンプレートを code をキーに集める。
// `vpnOnly` の論理 ID 不変性の検証で、同じ RegionConfig から作った `full` 側の
// テンプレートと比較するために使う。describe のコールバックは Jest の収集フェーズで
// 同期的に実行されるため、後続の `vpnOnly` describe ブロックの実行時点では
// 必ず埋まっている。
const fullTemplatesByCode = new Map<string, Template>();

// REGION_CONFIGS をループして検証する。リージョンを追加してもこのファイルの
// 書き換えが不要になることが目的。
REGION_CONFIGS.forEach((regionConfig) => {
  describe(`RegionStack (${regionConfig.code})`, () => {
    const isPrimary = regionConfig.onPremisesRole === 'primary';

    const stack = new RegionStack(newApp(), `RegionStack-${regionConfig.code}`, {
      regionConfig,
      cloudWan: FULL_CLOUD_WAN,
      // secondary のときのみ使われる (primary は自身で VPN ルーターを作るため無視される)
      ...(isPrimary ? {} : { routerElasticIp: ROUTER_ELASTIC_IP }),
    });
    const template = Template.fromStack(stack);
    fullTemplatesByCode.set(regionConfig.code, template);

    test('snapshot', () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    test('Cloud WAN への VpcAttachment は 1 つだけ (オンプレミス相当 VPC と TGW 配下 VPC はアタッチしない)', () => {
      // オンプレミス相当 VPC や TGW 配下 VPC を Cloud WAN に直接アタッチすると、
      // その CIDR が AS_PATH 長 1 相当の経路として全 CNE へ広報され、
      // TGW peering attachment 経由の経路 (AS_PATH 長 3 相当) に必ず勝ってしまう。
      // その結果、primary TGW 経由か secondary TGW 経由かを比較する検証そのものが
      // 無効化されるため、Cloud WAN への VpcAttachment は Cloud WAN 直アタッチ VPC
      // の 1 つだけに限定する。
      template.resourceCountIs('AWS::NetworkManager::VpcAttachment', 1);
    });

    test('AWS::EC2::TransitGatewayRouteTable が 1 つだけ', () => {
      // Cloud WAN が TGW peering attachment 経由で学習するのは、route table
      // attachment で紐付けた「この 1 つの Route Table」の中身だけ。
      // Site-to-Site VPN アタッチメントと VPC アタッチメントの association /
      // propagation 先を別の Route Table に分けると、Cloud WAN 側にオンプレミス
      // 経路が反映されない。しかもこの設定ミスはデプロイでもエラー / 警告として
      // 現れず、疎通確認して初めて「リモートリージョン経由になっている」ことに
      // 気づく類の罠なので、Route Table は 1 つであることを固定する。
      template.resourceCountIs('AWS::EC2::TransitGatewayRouteTable', 1);
    });

    test('AWS::EC2::FlowLog が 1 つで MaxAggregationInterval が 60', () => {
      // Transit Gateway 系リソースの Flow Logs は 60 秒固定が必須
      // (CfnFlowLogProps.maxAggregationInterval の JSDoc 参照)。既定値は 600 秒
      // で、L1 (ec2.CfnFlowLog) はこの制約を synth 時に検証しないため、
      // 明示していないとデプロイで初めて失敗する。
      template.resourceCountIs('AWS::EC2::FlowLog', 1);
      const flowLogs = template.findResources('AWS::EC2::FlowLog');
      const properties = Object.values(flowLogs)[0].Properties;
      expect(properties.MaxAggregationInterval).toBe(60);
    });

    test('AWS::EC2::VPNConnection に PreSharedKey が含まれない', () => {
      // 事前共有鍵をコードに書かず AWS 側の自動採番に任せる設計のため、
      // テンプレートのどこにも PreSharedKey という文字列が出現してはいけない。
      const vpnConnections = template.findResources('AWS::EC2::VPNConnection');
      expect(JSON.stringify(vpnConnections)).not.toContain('PreSharedKey');
    });

    test('AWS::EC2::VPNConnection の Name タグが vpnNameTagValue(code) と一致する', () => {
      // hasResourceProperties の arrayWith は Tags 配列の一部要素だけを見る際に
      // 取りこぼすことがあるため、findResources して JS 側でフィルタする。
      const vpnConnections = template.findResources('AWS::EC2::VPNConnection');
      const hasTag = Object.values(vpnConnections).some((resource) =>
        (resource.Properties.Tags ?? []).some(
          (tag: { Key: string; Value: string }) =>
            tag.Key === VPN_NAME_TAG.key &&
            tag.Value === vpnNameTagValue(regionConfig.code),
        ),
      );
      expect(hasTag).toBe(true);
    });

    if (isPrimary) {
      test('AWS::EC2::NetworkInterface が 2 つ (VPN ルーターの eth0 / eth1)、いずれも SourceDestCheck: false', () => {
        template.resourceCountIs('AWS::EC2::NetworkInterface', 2);
        const networkInterfaces = template.findResources(
          'AWS::EC2::NetworkInterface',
        );
        Object.values(networkInterfaces).forEach((resource) => {
          expect(resource.Properties.SourceDestCheck).toBe(false);
        });
      });

      test('AWS::EC2::InstanceConnectEndpoint が 1 つ (オンプレミス相当のみ)', () => {
        // EIC Endpoint はアカウント / リージョンあたり 5 個の hard quota があるため、
        // Cloud WAN 直アタッチ VPC / TGW 配下 VPC (PrivateVpc) では作らず、
        // 疎通確認用 EC2 は Public Subnet + SSM Session Manager 経由で接続する。
        // オンプレミス相当 VPC (VPN ルーター検証用の疎通確認用 EC2) の分だけが残る。
        template.resourceCountIs('AWS::EC2::InstanceConnectEndpoint', 1);
      });

      test('VPN ルーターの IAM ロールに AmazonSSMManagedInstanceCore が付与されている', () => {
        // このスタックには AmazonSSMManagedInstanceCore を持つロールが他にも
        // 存在する (TGW 配下 VPC / オンプレミス相当 VPC の疎通確認用 EC2 は
        // ssmSessionPermissions: true で同じマネージドポリシーを持つ)。
        // 「いずれかのロールが持っている」では検証にならないため、
        // ec2:DescribeVpnConnections のインラインポリシーを持つロール
        // (VPN ルーター自身のロール) を名指しで特定してから確認する。
        const roles = template.findResources('AWS::IAM::Role');
        const routerRoleEntry = Object.entries(roles).find(([, resource]) =>
          (resource.Properties.Policies ?? []).some(
            (policy: { PolicyDocument: { Statement: unknown[] } }) =>
              policy.PolicyDocument.Statement.some((statement) => {
                const { Action } = statement as { Action: string | string[] };
                const actions = Array.isArray(Action) ? Action : [Action];
                return actions.includes('ec2:DescribeVpnConnections');
              }),
          ),
        );
        expect(routerRoleEntry).toBeDefined();

        const [, routerRole] = routerRoleEntry!;
        expect(JSON.stringify(routerRole.Properties.ManagedPolicyArns)).toContain(
          'AmazonSSMManagedInstanceCore',
        );
      });
    } else {
      test('AWS::EC2::InstanceConnectEndpoint が 0 つ (オンプレミス相当 VPC を作らない)', () => {
        // secondary はオンプレミス相当 VPC を作らず、Cloud WAN 直アタッチ VPC /
        // TGW 配下 VPC (PrivateVpc) しか作らない。PrivateVpc は EIC を作らないため、
        // secondary の EIC は 0 個になる。
        template.resourceCountIs('AWS::EC2::InstanceConnectEndpoint', 0);
      });

      test('AWS::EC2::NetworkInterface が 0 つ (オンプレミス相当 VPC を作らない)', () => {
        template.resourceCountIs('AWS::EC2::NetworkInterface', 0);
      });
    }
  });
});

// `vpnOnly` デプロイ範囲 (Cloud WAN を作らず TGW + Site-to-Site VPN だけを
// デプロイするモード) の検証。`DEPLOYMENT_SCOPE` の値に依存せず、ここで
// 明示的に `cloudWan: { enabled: false }` を渡した RegionStack を作って検証する。
describe('RegionStack (vpnOnly)', () => {
  const vpnOnlyRegionConfigs = REGION_CONFIGS.filter(
    (regionConfig) => regionConfig.onPremisesNetwork === VPN_ONLY_TARGET_NETWORK,
  );
  const primaryRegionConfig = vpnOnlyRegionConfigs.find(
    (regionConfig) => regionConfig.onPremisesRole === 'primary',
  );
  const secondaryRegionConfig = vpnOnlyRegionConfigs.find(
    (regionConfig) => regionConfig.onPremisesRole === 'secondary',
  );
  if (primaryRegionConfig === undefined || secondaryRegionConfig === undefined) {
    throw new Error(
      `VPN_ONLY_TARGET_NETWORK (${VPN_ONLY_TARGET_NETWORK}) に対応する primary / secondary の RegionConfig が見つからない`,
    );
  }

  const primaryStack = new RegionStack(
    newApp(),
    `RegionStack-vpnOnly-${primaryRegionConfig.code}`,
    {
      regionConfig: primaryRegionConfig,
      cloudWan: VPN_ONLY_CLOUD_WAN,
    },
  );
  const primaryTemplate = Template.fromStack(primaryStack);

  const secondaryStack = new RegionStack(
    newApp(),
    `RegionStack-vpnOnly-${secondaryRegionConfig.code}`,
    {
      regionConfig: secondaryRegionConfig,
      cloudWan: VPN_ONLY_CLOUD_WAN,
      routerElasticIp: ROUTER_ELASTIC_IP,
    },
  );
  const secondaryTemplate = Template.fromStack(secondaryStack);

  test(`snapshot (${primaryRegionConfig.code})`, () => {
    expect(primaryTemplate.toJSON()).toMatchSnapshot();
  });

  test(`snapshot (${secondaryRegionConfig.code})`, () => {
    expect(secondaryTemplate.toJSON()).toMatchSnapshot();
  });

  test('AWS::NetworkManager:: 系リソースがすべて 0 件', () => {
    // Cloud WAN を作らないため、Cloud WAN 側のアタッチメント / peering /
    // registration / route table attachment は 1 件も存在してはいけない。
    [
      'AWS::NetworkManager::VpcAttachment',
      'AWS::NetworkManager::TransitGatewayPeering',
      'AWS::NetworkManager::TransitGatewayRegistration',
      'AWS::NetworkManager::TransitGatewayRouteTableAttachment',
    ].forEach((resourceType) => {
      primaryTemplate.resourceCountIs(resourceType, 0);
      secondaryTemplate.resourceCountIs(resourceType, 0);
    });
  });

  test('AWS::EC2::TransitGateway が 1 / AWS::EC2::VPNConnection が 1 / AWS::EC2::TransitGatewayRouteTable が 1', () => {
    [primaryTemplate, secondaryTemplate].forEach((template) => {
      template.resourceCountIs('AWS::EC2::TransitGateway', 1);
      template.resourceCountIs('AWS::EC2::VPNConnection', 1);
      template.resourceCountIs('AWS::EC2::TransitGatewayRouteTable', 1);
    });
  });

  test('AWS::EC2::FlowLog が 1 で MaxAggregationInterval が 60', () => {
    // Flow Logs は TGW に紐付いているのでスコープ切り替えで消えないはずだが、
    // 想定に頼らず実際に検証する。
    [primaryTemplate, secondaryTemplate].forEach((template) => {
      template.resourceCountIs('AWS::EC2::FlowLog', 1);
      const flowLogs = template.findResources('AWS::EC2::FlowLog');
      const properties = Object.values(flowLogs)[0].Properties;
      expect(properties.MaxAggregationInterval).toBe(60);
    });
  });

  test(`${primaryRegionConfig.code}: AWS::EC2::NetworkInterface が 2 つ、いずれも SourceDestCheck: false / AWS::EC2::InstanceConnectEndpoint が 1 つ`, () => {
    primaryTemplate.resourceCountIs('AWS::EC2::NetworkInterface', 2);
    const networkInterfaces = primaryTemplate.findResources(
      'AWS::EC2::NetworkInterface',
    );
    Object.values(networkInterfaces).forEach((resource) => {
      expect(resource.Properties.SourceDestCheck).toBe(false);
    });

    // PrivateVpc (Cloud WAN 直アタッチ / TGW 配下) は EIC を作らないため、
    // vpnOnly で Cloud WAN 直アタッチ VPC を作らなくても数は変わらない。
    // オンプレミス相当 VPC の疎通確認用 EC2 の分だけが残り、full と同じ 1 つ。
    primaryTemplate.resourceCountIs('AWS::EC2::InstanceConnectEndpoint', 1);
  });

  test(`${secondaryRegionConfig.code}: AWS::EC2::InstanceConnectEndpoint が 0 つ`, () => {
    // secondary はオンプレミス相当 VPC を作らず、PrivateVpc (TGW 配下) しか
    // 作らない。PrivateVpc は EIC を作らないため、full と同じ 0 個のまま。
    secondaryTemplate.resourceCountIs('AWS::EC2::InstanceConnectEndpoint', 0);
  });

  test('論理 ID の不変性: vpnOnly の論理 ID はすべて full の同じスタックに同じ名前で存在する', () => {
    // `vpnOnly` から `full` へデプロイ範囲を戻すときに、CloudFormation が
    // 既存リソースを置き換えないための前提条件。論理 ID が 1 つでも変わっていると
    // vpnOnly で作ったリソースが一度削除されてから full 側の同名リソースが
    // 新規作成される (無停止での移行ができなくなる)。
    const assertLogicalIdsAreSubset = (
      vpnOnlyTemplate: Template,
      fullTemplate: Template,
    ): void => {
      const vpnOnlyLogicalIds = Object.keys(
        vpnOnlyTemplate.toJSON().Resources ?? {},
      );
      const fullLogicalIds = new Set(
        Object.keys(fullTemplate.toJSON().Resources ?? {}),
      );
      vpnOnlyLogicalIds.forEach((logicalId) => {
        expect(fullLogicalIds.has(logicalId)).toBe(true);
      });
    };

    const fullPrimaryTemplate = fullTemplatesByCode.get(primaryRegionConfig.code);
    const fullSecondaryTemplate = fullTemplatesByCode.get(
      secondaryRegionConfig.code,
    );
    if (fullPrimaryTemplate === undefined || fullSecondaryTemplate === undefined) {
      throw new Error('full 側の RegionStack テンプレートが見つからない');
    }

    assertLogicalIdsAreSubset(primaryTemplate, fullPrimaryTemplate);
    assertLogicalIdsAreSubset(secondaryTemplate, fullSecondaryTemplate);
  });
});
