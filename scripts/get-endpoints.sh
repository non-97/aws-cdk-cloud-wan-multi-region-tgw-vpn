#!/usr/bin/env bash
#
# 各リージョンの EC2 インスタンス (プライベート / パブリック IP) と、
# VPN ルーターの Elastic IP の一覧を VPC 別にテーブル表示する。
#
# 元ネタ: 20260622_cloud-wan-nfg-failover-routing/aws-cdk-cloud-wan-nfg-failover-routing/scripts/get-endpoints.sh
# 本環境向けの変更点:
#   - REGIONS を本環境の 4 リージョンに置き換え、対応する CloudFormation
#     スタック名 (STACK_NAMES) を対で持たせた
#   - describe-instances / describe-addresses を、いずれも
#     `tag:aws:cloudformation:stack-name` でこのプロジェクトのスタックに
#     絞り込むようにした。アカウント内に他環境の EC2 インスタンスも起動して
#     いるため、フィルタ無しで実行すると無関係なインスタンスまで一覧に出る
#   - インスタンス一覧に PUBLIC-IP 列と SSM 列 (Session Manager で実際に
#     入れるか、`ssm describe-instance-information` と突き合わせ) を追加した。
#     Cloud WAN 直アタッチ VPC / TGW 配下 VPC の EC2 は Public Subnet + SSM
#     接続に変えたため、動的パブリック IP を持つインスタンスが増えている。
#     SSM 列はあくまで参考情報であり、インスタンスの絞り込みには使わない
#     (他環境のインスタンスも SSM マネージドノードでありうるため、SSM
#     登録状態だけでは「このプロジェクトのものか」を判定できない)
#   - VPN ルーター (ec2.CfnInstance、L1) は CDK が Name タグを自動付与しないため、
#     ネットワークインタフェース数 (eth0+eth1 の 2 枚) を目印に "(VPN Router)" と
#     フォールバック表示する
#   - natGateways: 0 のため NAT Gateway は存在しない。同じ役割 (パブリック接続点の
#     一覧) を、VPN ルーターの Elastic IP 一覧 (describe-addresses) に置き換えた
#   - EC2 Instance Connect Endpoint の一覧は本環境では不要なため含めない
#   - 各リージョンの Transit Gateway 本体 (ID / ASN / State) と、そこにぶら下がる
#     アタッチメント一覧 (ID / リソースタイプ vpc,vpn,peering 等 / リソース ID / State)
#     を表示するセクションを追加した。TGW も他リソースと同じく
#     `tag:aws:cloudformation:stack-name` で絞り込む
#
# 必要ツール: aws-cli, jq, column
# 使い方:
#   awsume <profile> && aws sts get-caller-identity
#   ./scripts/get-endpoints.sh
#
set -uo pipefail

REGIONS=(ap-northeast-1 ap-northeast-3 us-east-1 us-west-2)
STACK_NAMES=(
  CloudWanRoutingRegionStack-apne1
  CloudWanRoutingRegionStack-apne3
  CloudWanRoutingRegionStack-use1
  CloudWanRoutingRegionStack-usw2
)

echo "=============================="
echo " EC2 Instances (Private / Public IP)"
echo "=============================="
echo

for i in "${!REGIONS[@]}"; do
  region=${REGIONS[$i]}
  stack_name=${STACK_NAMES[$i]}

  instances=$(aws ec2 describe-instances \
    --region "$region" \
    --filters \
      "Name=instance-state-name,Values=running" \
      "Name=tag:aws:cloudformation:stack-name,Values=$stack_name" \
    --query 'Reservations[].Instances[].{
      Name: Tags[?Key==`Name`].Value | [0],
      InstanceId: InstanceId,
      AZ: Placement.AvailabilityZone,
      PrivateIp: PrivateIpAddress,
      PublicIp: PublicIpAddress,
      VpcId: VpcId,
      NicCount: NetworkInterfaces | length(@)
    }' \
    --output json)

  count=$(echo "$instances" | jq length)
  if [ "$count" -eq 0 ]; then
    continue
  fi

  # SSM マネージドノードとして登録されているインスタンス ID の集合を取る。
  # ここで取れるのはリージョン内の全マネージドノードであり、このプロジェクトの
  # ものだけではないが、上の $instances 側が既にスタック名で絞ってあるため、
  # 突き合わせた結果 (SSM 列) はこのプロジェクトのインスタンスについてのみ意味を持つ。
  ssm_ids=$(aws ssm describe-instance-information \
    --region "$region" \
    --query 'InstanceInformationList[].InstanceId' \
    --output json)

  echo "--- $region ($stack_name, $count instances) ---"
  echo "$instances" | jq -r \
    --argjson ssm_ids "$ssm_ids" '
    ($ssm_ids | map({(.): true}) | add // {}) as $ssm |
    ["NAME","INSTANCE-ID","AZ","PRIVATE-IP","PUBLIC-IP","VPC-ID","SSM"],
    (sort_by(.AZ, .Name)[] | [
      (.Name // (if .NicCount == 2 then "(VPN Router)" else "-" end)),
      .InstanceId,
      .AZ,
      .PrivateIp,
      (.PublicIp // "-"),
      .VpcId,
      (if $ssm[.InstanceId] then "yes" else "no" end)
    ]) | @tsv' \
  | column -t -s $'\t'
  echo
done

echo "=============================="
echo " Elastic IP (VPN Router)"
echo "=============================="
echo
echo

for i in "${!REGIONS[@]}"; do
  region=${REGIONS[$i]}
  stack_name=${STACK_NAMES[$i]}

  addresses=$(aws ec2 describe-addresses \
    --region "$region" \
    --filters "Name=tag:aws:cloudformation:stack-name,Values=$stack_name" \
    --query 'Addresses[?InstanceId != `null`].{
      InstanceId: InstanceId,
      PublicIp: PublicIp,
      PrivateIp: PrivateIpAddress,
      AllocationId: AllocationId
    }' \
    --output json)

  count=$(echo "$addresses" | jq length)
  if [ "$count" -eq 0 ]; then
    continue
  fi

  echo "--- $region ($stack_name, $count Elastic IP) ---"
  echo "$addresses" | jq -r '
    ["INSTANCE-ID","PUBLIC-IP","PRIVATE-IP","ALLOCATION-ID"],
    (sort_by(.InstanceId)[] | [
      .InstanceId,
      .PublicIp,
      (.PrivateIp // "-"),
      .AllocationId
    ]) | @tsv' \
  | column -t -s $'\t'
  echo
done

echo "=============================="
echo " Transit Gateway (ID / ASN) と アタッチメント"
echo "=============================="
echo

for i in "${!REGIONS[@]}"; do
  region=${REGIONS[$i]}
  stack_name=${STACK_NAMES[$i]}

  tgw=$(aws ec2 describe-transit-gateways \
    --region "$region" \
    --filters "Name=tag:aws:cloudformation:stack-name,Values=$stack_name" \
    --query 'TransitGateways[0].{
      TransitGatewayId: TransitGatewayId,
      AmazonSideAsn: AmazonSideAsn,
      State: State
    }' \
    --output json)

  tgw_id=$(echo "$tgw" | jq -r '.TransitGatewayId // empty')
  if [ -z "$tgw_id" ]; then
    continue
  fi

  echo "--- $region ($stack_name) ---"
  echo "$tgw" | jq -r '
    ["TGW-ID","ASN","STATE"],
    [.TransitGatewayId, (.AmazonSideAsn | tostring), .State] | @tsv' \
  | column -t -s $'\t'
  echo

  attachments=$(aws ec2 describe-transit-gateway-attachments \
    --region "$region" \
    --filters "Name=transit-gateway-id,Values=$tgw_id" \
    --query 'TransitGatewayAttachments[].{
      AttachmentId: TransitGatewayAttachmentId,
      ResourceType: ResourceType,
      ResourceId: ResourceId,
      State: State
    }' \
    --output json)

  echo "$attachments" | jq -r '
    ["ATTACHMENT-ID","RESOURCE-TYPE","RESOURCE-ID","STATE"],
    (sort_by(.ResourceType, .AttachmentId)[] | [
      .AttachmentId,
      .ResourceType,
      (.ResourceId // "-"),
      .State
    ]) | @tsv' \
  | column -t -s $'\t'
  echo
done
