import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as path from 'path';
import { Construct } from 'constructs';
import { CLOUD_WAN } from '../network-config';

/** vpn-router-bootstrap.sh の配置先 (systemd unit の ExecStart と一致させる) */
const BOOTSTRAP_SCRIPT_PATH = '/opt/vpn-router-bootstrap.sh';
/** set-return-path.sh の配置先 (README の操作手順と一致させる) */
const SET_RETURN_PATH_SCRIPT_PATH = '/opt/set-return-path.sh';
/** vpn-router-bootstrap.sh と共有する状態ファイルのパス */
const VPN_ROUTER_STATUS_FILE = '/run/vpn-router-status';

/**
 * CDK Asset (S3) からファイルをリトライ付きでダウンロードするコマンド列を追加する。
 *
 * `UserData.addS3DownloadCommand` は単発の `aws s3 cp` を生成するだけでリトライが
 * 無い。cloud-init 実行開始時点では IMDS がまだインスタンスプロファイルの認証情報を
 * 返せないことがあり、その場合 `aws s3 cp` が "Unable to locate credentials" で
 * 失敗する (実機確認済み)。呼び出し側で IMDS の認証情報が返るまで待ってはいるが、
 * それでも失敗する余地を残さないよう、ダウンロード自体もリトライする。
 *
 * 最終的に失敗した場合はここで userdata を止める。ダウンロード失敗を無視して
 * 進めると、空ファイルや前回分の古いファイルを実行してしまい、かつ痕跡が
 * 残らない (何が起きたか分からない) 事態になるため。
 */
const addRetryingS3Download = (
  userData: ec2.UserData,
  asset: Asset,
  localPath: string,
): void => {
  userData.addCommands(
    `mkdir -p "$(dirname '${localPath}')"`,
    'DOWNLOAD_OK=0',
    'for i in $(seq 1 10); do',
    `  if aws s3 cp 's3://${asset.s3BucketName}/${asset.s3ObjectKey}' '${localPath}'; then`,
    '    DOWNLOAD_OK=1',
    '    break',
    '  fi',
    `  echo "S3 download retry (\${i}/10): ${localPath}"`,
    '  sleep 5',
    'done',
    'if [ "${DOWNLOAD_OK}" != "1" ]; then',
    `  echo "ERROR: failed to download ${localPath} from S3" >&2`,
    '  exit 1',
    'fi',
    `chmod +x '${localPath}'`,
  );
};

export interface OnPremisesVpcProps {
  /** VPC CIDR ブロック */
  readonly vpcCidr: string;
  /** VPN ルーター (FRR) の BGP ASN */
  readonly routerAsn: number;
  /**
   * Site-to-Site VPN 接続を検索するリージョン。
   * 1 番目が東京、2 番目が大阪。
   */
  readonly vpnSearchRegions: readonly string[];
  /** VPN 接続の検索に使う Name タグのキー */
  readonly vpnNameTagKey: string;
  /**
   * VPN 接続の検索に使う Name タグの値。
   * `vpnSearchRegions` と同じ順序 (1 番目が東京、2 番目が大阪)。
   */
  readonly vpnNameTagValues: readonly string[];
  /**
   * Site-to-Site VPN の AWS 側 (Transit Gateway) の BGP ASN。
   * `vpnSearchRegions` / `vpnNameTagValues` と同じ順序 (1 番目が primary、2 番目が secondary)。
   * VPN ルーターの FRR 設定で `neighbor <IP> remote-as <この値>` に使う。
   */
  readonly awsAsns: readonly number[];
}

/**
 * オンプレミス相当 VPC。
 *
 * 東京 TGW / 大阪 TGW への Site-to-Site VPN (計 4 トンネル) を自作 EC2 ルーター
 * (Libreswan + FRR) で終端し、東京/大阪どちら経由でも Cloud WAN 側の VPC と
 * 疎通できることを検証するための拠点。
 *
 * 【重要】この VPC は Cloud WAN にアタッチしてはいけない。
 * もし Cloud WAN Core Network にこの VPC (10.100.0.0/16) を直接アタッチすると、
 * その CIDR は「VPC アタッチメント由来の経路」(AS_PATH 長 1 相当) として
 * 全 Core Network Edge へ広報されてしまう。一方、この構成で本来検証したい
 * 経路は TGW peering attachment 経由 (AS_PATH 長 3 相当) であり、
 * Cloud WAN の経路選択は AS_PATH 長の短い方を優先するため、
 * VPC アタッチメント由来の経路が常に勝ってしまう。
 * その結果、東京 TGW 経由か大阪 TGW 経由かを BGP / Routing Policy で
 * 制御して比較するという検証そのものが成立しなくなる。
 */
export class OnPremisesVpc extends Construct {
  public readonly routerElasticIp: string;
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: OnPremisesVpcProps) {
    super(scope, id);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: 1,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
          mapPublicIpOnLaunch: true,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });
    this.vpc = vpc;

    const publicSubnet = vpc.selectSubnets({ subnetGroupName: 'Public' })
      .subnets[0];
    const privateSubnet = vpc.selectSubnets({ subnetGroupName: 'Private' })
      .subnets[0];

    const vpnRouterSg = new ec2.SecurityGroup(this, 'VpnRouterSg', {
      vpc,
      description: 'for VPN Router',
    });
    vpnRouterSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(500));
    vpnRouterSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(4500));
    vpnRouterSg.addIngressRule(
      ec2.Peer.ipv4(CLOUD_WAN.routeDestinationCidr),
      ec2.Port.allTraffic(),
    );

    const eth0 = new ec2.CfnNetworkInterface(this, 'RouterEth0', {
      description: 'VPN Router eth0 (Public)',
      subnetId: publicSubnet.subnetId,
      groupSet: [vpnRouterSg.securityGroupId],
      // マルチ ENI 構成では全 ENI の source/dest check を無効化する必要がある
      // (これが有効なままだと転送パケットが drop される)。
      sourceDestCheck: false,
    });

    const eth1 = new ec2.CfnNetworkInterface(this, 'RouterEth1', {
      description: 'VPN Router eth1 (Private)',
      subnetId: privateSubnet.subnetId,
      groupSet: [vpnRouterSg.securityGroupId],
      sourceDestCheck: false,
    });

    const routerEip = new ec2.CfnEIP(this, 'RouterEip', { domain: 'vpc' });
    new ec2.CfnEIPAssociation(this, 'RouterEipAssociation', {
      allocationId: routerEip.attrAllocationId,
      networkInterfaceId: eth0.attrId,
    });
    this.routerElasticIp = routerEip.ref;

    // userdata から参照する 2 スクリプトを CDK Asset (S3) 経由で配信する。
    const bootstrapAsset = new Asset(this, 'BootstrapScriptAsset', {
      path: path.join(__dirname, '../../src/ec2/vpn-router-bootstrap.sh'),
    });
    const setReturnPathAsset = new Asset(this, 'SetReturnPathScriptAsset', {
      path: path.join(__dirname, '../../src/ec2/set-return-path.sh'),
    });

    const routerRole = new iam.Role(this, 'VpnRouterRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      // VPN ルーターを SSM マネージドノードにする。userdata のシェルスクリプトは
      // cloud-init の scripts-user が per-instance で 1 回しか実行しないため、
      // 失敗しても再実行されない。中に入って状態を確認できないと、原因を特定
      // できないまま CloudFormation のサイクル (1 回 10 分) を回すことになる。
      // Session Manager と ssm send-command で直接確認 / 再実行できるようにする。
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
      inlinePolicies: {
        vpnRouterPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ec2:DescribeVpnConnections'],
              resources: ['*'],
            }),
          ],
        }),
      },
    });
    bootstrapAsset.grantRead(routerRole);
    setReturnPathAsset.grantRead(routerRole);

    const routerProfile = new iam.CfnInstanceProfile(
      this,
      'VpnRouterInstanceProfile',
      { roles: [routerRole.roleName] },
    );

    // userdata は「env を書く → スクリプトを取得する → systemd の unit と
    // timer を設置して起動する」までの薄いブートストラップにする。
    // ブートストラップ本体 (vpn-router-bootstrap.sh) はここでは実行しない。
    // 実行と再試行は vpn-router-converge.timer に委ねる。userdata 自身は
    // インスタンスごとに 1 回しか実行されない (cloud-init の scripts-user の
    // 仕様) ため、userdata の中で本体を直接叩く方式だと本体側の exit 1 が
    // 二度と再試行されない欠陥につながる。
    //
    // cdk.Fn.sub は使わない。
    // 理由: vpn-router-bootstrap.sh は bash の連想配列インデックスを
    // `${!ARR[@]}` で取得する箇所を含むが、CloudFormation の Fn::Sub は
    // `${!VAR}` を「エスケープされた ${VAR}」と解釈して `!` を剥がしてしまう。
    // その結果 `${!ARR[@]}` (インデックス取得) が `${ARR[@]}` (値の展開) に
    // 変わり、ループがインデックスではなく値を反復して userdata が全破綻する。
    // これは cdk synth では検出できず、cloud-init のログで初めて判明する。
    // 対処として、変数は Fn::Sub を使わず /etc/vpn-router.env に書き出し、
    // スクリプト側はそれを source するだけの「普通の bash」として扱う。
    const userData = ec2.UserData.forLinux();

    // IMDSv2 のトークンを取得し、インスタンスプロファイルの認証情報が
    // 返せるようになるまで待つ。cloud-init 実行開始の時点ではまだ IMDS が
    // 認証情報を返せないことがあり、その状態で後続の `aws s3 cp` を実行すると
    // "Unable to locate credentials" で失敗する (実機確認済み)。上限を設けて
    // 無限ループにはしない。
    userData.addCommands(
      'IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")',
      'CREDENTIALS_READY=0',
      'for i in $(seq 1 30); do',
      '  CREDS=$(curl -s -H "X-aws-ec2-metadata-token: ${IMDS_TOKEN}" http://169.254.169.254/latest/meta-data/iam/security-credentials/)',
      '  if [ -n "${CREDS}" ]; then',
      '    CREDENTIALS_READY=1',
      '    break',
      '  fi',
      '  echo "Waiting for IMDS credentials... (${i}/30)"',
      '  sleep 2',
      'done',
      'if [ "${CREDENTIALS_READY}" != "1" ]; then',
      '  echo "WARNING: IMDS credentials did not become available within the retry budget" >&2',
      'fi',
    );

    userData.addCommands(
      'cat <<EOF > /etc/vpn-router.env',
      `ONPREM_VPC_CIDR=${props.vpcCidr}`,
      `ROUTER_ASN=${props.routerAsn}`,
      `VPN_SEARCH_REGIONS=${props.vpnSearchRegions.join(',')}`,
      `VPN_NAME_TAG_KEY=${props.vpnNameTagKey}`,
      `VPN_NAME_TAG_VALUES=${props.vpnNameTagValues.join(',')}`,
      `PRIMARY_AWS_ASN=${props.awsAsns[0]}`,
      `SECONDARY_AWS_ASN=${props.awsAsns[1]}`,
      'EOF',
    );

    addRetryingS3Download(userData, setReturnPathAsset, SET_RETURN_PATH_SCRIPT_PATH);
    addRetryingS3Download(userData, bootstrapAsset, BOOTSTRAP_SCRIPT_PATH);

    // ブートストラップ本体の実行と再試行は systemd timer に委ねる
    // (vpn-router-bootstrap.sh 側は自身でこの timer を設置しない。
    // 設置前に exit 1 する経路が複数あり、途中で失敗すると timer が
    // 一生設置されず再試行されなくなるため)。
    userData.addCommands(
      'cat <<EOF > /etc/systemd/system/vpn-router-converge.service',
      '[Unit]',
      'Description=Re-run vpn-router-bootstrap.sh until all 4 tunnels are established',
      '',
      '[Service]',
      'Type=oneshot',
      `ExecStart=${BOOTSTRAP_SCRIPT_PATH}`,
      'StandardOutput=append:/var/log/vpn-router-bootstrap.log',
      'StandardError=append:/var/log/vpn-router-bootstrap.log',
      'EOF',
    );

    userData.addCommands(
      'cat <<EOF > /etc/systemd/system/vpn-router-converge.timer',
      '[Unit]',
      'Description=Retry vpn-router-bootstrap.sh every 5 minutes until convergence',
      '',
      '[Timer]',
      'OnBootSec=1min',
      'OnUnitActiveSec=5min',
      'Unit=vpn-router-converge.service',
      '',
      '[Install]',
      'WantedBy=timers.target',
      'EOF',
    );

    userData.addCommands('systemctl daemon-reload');

    // この行 (`pending:timer-installed` の書き込み) は userdata の一部であり、
    // cloud-init の scripts-user の仕様によりインスタンスごとに 1 回しか
    // 実行されない (再起動のたびには実行されない)。
    // 状態ファイルは /run (tmpfs) に置いているため、再起動のたびに中身は
    // 必ず消え、次回起動時は毎回「ファイルが無い」状態になる。
    // vpn-router-converge.timer の OnBootSec=1min はこの「ファイルが無い」を
    // 正しく「未収束」と判定し、起動のたびに収束処理
    // (vpn-router-bootstrap.sh) を自動的に回す。
    userData.addCommands(`echo pending:timer-installed > ${VPN_ROUTER_STATUS_FILE}`);

    userData.addCommands('systemctl enable --now vpn-router-converge.timer');

    const routerAmiId = ssm.StringParameter.valueForStringParameter(
      this,
      '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64',
    );

    new ec2.CfnInstance(this, 'VpnRouter', {
      imageId: routerAmiId,
      instanceType: 't3.small',
      iamInstanceProfile: routerProfile.ref,
      networkInterfaces: [
        { networkInterfaceId: eth0.ref, deviceIndex: '0' },
        { networkInterfaceId: eth1.ref, deviceIndex: '1' },
      ],
      userData: cdk.Fn.base64(userData.render()),
    });

    // 疎通確認用 EC2。
    //
    // 【重要】VPN ルーターの eth1 と必ず同一サブネットに置くこと。
    // vpn-router-bootstrap.sh が生成する FRR 設定は
    // `aggregate-address <ONPREM_VPC_CIDR> summary-only` を使って集約経路を
    // 広報するが、このコマンドは集約対象 CIDR 宛の Null0 ブラックホールを
    // ルーター自身 (FRR) に install するという副作用を持つ。
    // ルーターが直結していない (=connected でない) サブネットに疎通確認用
    // EC2 を置くと、そのサブネット宛のパケットは具体的な経路を持たず
    // ブラックホールに吸われて転送不能になる。ルーターの eth1 と同一の
    // Private サブネットに置けば、そのサブネットはルーターに connected と
    // なり、ブラックホールより優先される具体的経路として扱われる。
    const verificationSg = new ec2.SecurityGroup(this, 'Ec2Sg', {
      vpc,
      description: 'for verification EC2 instance',
    });
    verificationSg.addIngressRule(
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
      securityGroup: verificationSg,
      ssmSessionPermissions: true,
    });

    const eicSg = new ec2.SecurityGroup(this, 'EicSg', {
      vpc,
      description: 'for EIC Endpoint',
      allowAllOutbound: false,
    });
    eicSg.addEgressRule(ec2.Peer.ipv4(props.vpcCidr), ec2.Port.tcp(22));

    new ec2.CfnInstanceConnectEndpoint(this, 'EicEndpoint', {
      subnetId: privateSubnet.subnetId,
      securityGroupIds: [eicSg.securityGroupId],
    });

    new ec2.CfnRoute(this, 'PrivateSubnetDefaultRoute', {
      routeTableId: privateSubnet.routeTable.routeTableId,
      destinationCidrBlock: '0.0.0.0/0',
      networkInterfaceId: eth1.attrId,
    });
  }
}
