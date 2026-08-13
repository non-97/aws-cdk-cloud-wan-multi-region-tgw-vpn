#!/usr/bin/env bash
#
# Cloud WAN Core Network の FIB (確定ルート = get-network-routes) をセグメント × リージョンごとに
# 取得し、次ホップを「どのリージョンの何のアタッチメントか」が一目で分かる形に解決して表示する。
#
# 本検証環境には NFG (Network Function Group) は無い。セグメントは "verification" の 1 つのみ。
# 候補ルート (BGP 属性付き) を見たい場合は get-rib.sh を使う。
# Routing Policy の効果確認は必ずこの get-fib.sh (FIB) で行うこと。
# RIB (get-rib.sh) はポリシー適用前の情報しか返さないため、ポリシーの効果確認には使えない。
#
# オンプレミス相当ネットワークは jp (10.100.0.0/16) と us (10.200.0.0/16) の 2 つがあり、
# それぞれ別ペアの TGW (jp: ap-northeast-1/ap-northeast-3, us: us-east-1/us-west-2) から
# Cloud WAN に入ってくる。
#
# 必要ツール: aws-cli, jq
# 使い方:
#   awsume <profile> && aws sts get-caller-identity
#   ./scripts/get-fib.sh
#
set -uo pipefail

# Network Manager (Cloud WAN) のグローバル API リージョン。
NM_REGION=${NM_REGION:-us-west-2}

SEGMENT=verification
# セグメントは全エッジ (東京 / 大阪 / バージニア北部 / オレゴン) に存在する。
SEGMENT_EDGES=(ap-northeast-1 ap-northeast-3 us-east-1 us-west-2)

CORE_NETWORK_ID=$(aws networkmanager list-core-networks --region "$NM_REGION" \
  --query 'CoreNetworks[0].CoreNetworkId' --output text)
GLOBAL_NETWORK_ID=$(aws networkmanager list-core-networks --region "$NM_REGION" \
  --query 'CoreNetworks[0].GlobalNetworkId' --output text)
echo "CoreNetwork=$CORE_NETWORK_ID  GlobalNetwork=$GLOBAL_NETWORK_ID  (NM_REGION=$NM_REGION)"

# attachment-id -> {region, type}。
# type は AttachmentType をそのまま使う (VPC = Cloud WAN 直アタッチ VPC,
# TRANSIT_GATEWAY_ROUTE_TABLE = TGW route table attachment, SITE_TO_SITE_VPN = S2S VPN)。
ATT_JSON=$(aws networkmanager list-attachments --region "$NM_REGION" \
  --core-network-id "$CORE_NETWORK_ID" \
  --query 'Attachments[].{Id:AttachmentId,Region:EdgeLocation,Type:AttachmentType,ResourceArn:ResourceArn}' \
  --output json)
ATT_MAP=$(echo "$ATT_JSON" | jq 'map({(.Id): {region:.Region, type:.Type}}) | add // {}')

echo
echo "===== attachment 凡例 ====="
echo "$ATT_JSON" | jq -r '
  ["ATTACHMENT","REGION","TYPE","RESOURCE-ARN"],
  (sort_by(.Region)[] | [.Id, .Region, .Type, .ResourceArn])
  | @tsv' | column -t -s $'\t'

# 指定ルートテーブルのルートを取得し、次ホップを <region>/<type> に解決して表示する。
print_routes() {
  local rti="$1"
  aws networkmanager get-network-routes --region "$NM_REGION" \
    --global-network-id "$GLOBAL_NETWORK_ID" \
    --route-table-identifier "$rti" --output json \
  | jq -r --argjson att "$ATT_MAP" '
      ["CIDR","TYPE","STATE","NEXT-HOP","ATTACHMENT"],
      (.NetworkRoutes
        | sort_by(.DestinationCidrBlock | split("/")[0] | split(".") | map(tonumber))
        | .[] | . as $r | ($r.Destinations // []) as $d
        | ([ $d[]
              | if .CoreNetworkAttachmentId then
                  # アタッチメント宛: <region>/<AttachmentType> (Cloud WAN 直アタッチ VPC か
                  # TGW route table attachment かを区別できる)。
                  (($att[.CoreNetworkAttachmentId]) // {region:"?",type:"?"} | "\(.region)/\(.type)")
                elif .EdgeLocation then
                  "EDGE:\(.EdgeLocation)"
                else "blackhole" end
            ] | join(",")) as $nh
        | ([ $d[].CoreNetworkAttachmentId ] | join(",")) as $aid
        | [ $r.DestinationCidrBlock, $r.Type, $r.State,
            (if $nh=="" then "-" else $nh end),
            (if $aid=="" then "-" else $aid end) ]
      ) | @tsv' \
  | column -t -s $'\t'
}

# ===== セグメント verification × 各リージョン (東京 / 大阪 / バージニア北部 / オレゴン) =====
for EDGE in "${SEGMENT_EDGES[@]}"; do
  echo
  echo "===== SEGMENT=$SEGMENT  EDGE=$EDGE ====="
  print_routes "CoreNetworkSegmentEdge={CoreNetworkId=$CORE_NETWORK_ID,SegmentName=$SEGMENT,EdgeLocation=$EDGE}"
done
