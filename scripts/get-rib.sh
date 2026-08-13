#!/usr/bin/env bash
#
# Cloud WAN コアネットワークの「ルーティング情報ベース (RIB)」をセグメント × リージョンごとに取得する。
#
# 重要: RIB は routing policy 適用「前」の情報を返す。ポリシーの効果確認は必ず get-fib.sh
# (FIB = get-network-routes、適用後の確定ルート) で行うこと。RIB は BGP 属性
# (Local Preference / AS Path / MED / Community) 付きの候補ルートを見せるため、
# AS_PATH の等長性判定や CNE 間トランジットの有無の判定に使う。
#
# 本検証環境のセグメントは "verification" の 1 つのみ。NFG は無いため NFG 関連の処理は無い。
#
# 使い方:
#   awsume <profile> && aws sts get-caller-identity   # 認証
#   ./scripts/get-rib.sh
#
set -uo pipefail

# Network Manager (Cloud WAN) のグローバル API リージョン。
NM_REGION=${NM_REGION:-us-west-2}

SEGMENT=verification
# RIB はセグメント単位 (NFG 指定は無い)。セグメントは全エッジ (東京 / 大阪 / バージニア北部 / オレゴン) に存在する。
SEGMENT_EDGES=(ap-northeast-1 ap-northeast-3 us-east-1 us-west-2)

CORE_NETWORK_ID=$(aws networkmanager list-core-networks --region "$NM_REGION" \
  --query 'CoreNetworks[0].CoreNetworkId' --output text)
echo "CoreNetwork=$CORE_NETWORK_ID  (NM_REGION=$NM_REGION)"

# console の RIB 列に対応: Prefix / NextHop(エッジ・セグメント・種別) / LocalPref / MED / ASパス / Community
# AsPath はスペース区切りの ASN 列。JMESPath はバッククォート内の前後空白を除去する
# (join(` `, ...) と書くと区切り文字の空白が消えて `` になり ASN が連結されて読めなくなる) ため、
# 素の ` ` ではなく JSON 文字列リテラル `" "` を区切り文字に使う。
QUERY='CoreNetworkRoutingInformation[].{Prefix:Prefix,Edge:NextHop.EdgeLocation,Seg:NextHop.SegmentName,Type:NextHop.ResourceType,LocalPref:LocalPreference,Med:Med,AsPath:join(`" "`,AsPath||`[]`),Comm:join(`,`,Communities||`[]`)}'

for EDGE in "${SEGMENT_EDGES[@]}"; do
  echo "===== RIB  SEGMENT=$SEGMENT  EDGE=$EDGE ====="
  aws networkmanager list-core-network-routing-information --region "$NM_REGION" \
    --core-network-id "$CORE_NETWORK_ID" \
    --segment-name "$SEGMENT" \
    --edge-location "$EDGE" \
    --query "$QUERY" --output json \
  | jq -r '
      ["PREFIX","EDGE","SEG","TYPE","LOCAL-PREF","MED","AS-PATH","COMMUNITY"],
      (sort_by(.Prefix | split("/")[0] | split(".") | map(tonumber))
        | .[] | [(.Prefix // "-"), (.Edge // "-"), (.Seg // "-"), (.Type // "-"),
                  (.LocalPref // "-"), (.Med // "-"),
                  (if .AsPath == "" then "-" else .AsPath end),
                  (if .Comm == "" then "-" else .Comm end)]
      ) | @tsv' \
  | column -t -s $'\t'
done
