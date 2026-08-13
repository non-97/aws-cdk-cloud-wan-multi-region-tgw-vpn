#!/usr/bin/env bash
#
# 戻り方向 (オンプレミス相当 VPC から primary / secondary VPC への向き) の経路を切り替える。
#
# Cloud WAN Routing Policy が制御できるのは AWS -> オンプレミスの向きだけなので、
# 戻り方向は VPN ルーター上の BGP ベストパス選択で固定する。
# route-map PREFER_IN で該当リージョン側の 2 ネイバーから受信した経路に
# local-preference を上げて、往路と復路の対称性を検証できるようにする。
#
# どのリージョンが primary かはルーターごとに異なる (VPN ルーターは jp 用 / us 用の
# 2 台あり、それぞれ別のプライマリ/セカンダリのペアを担当する)。
#
# 使い方: set-return-path.sh <primary|secondary|none>
#
set -uo pipefail

MODE="${1:-}"
if [ "${MODE}" != "primary" ] && [ "${MODE}" != "secondary" ] && [ "${MODE}" != "none" ]; then
  echo "使い方: $0 <primary|secondary|none>" >&2
  exit 1
fi

VPN_ENV_FILE=/etc/vpn-router.env
NEIGHBORS_FILE=/etc/vpn-router-neighbors.env

if [ ! -f "${VPN_ENV_FILE}" ]; then
  echo "ERROR: ${VPN_ENV_FILE} が見つからない (vpn-router-bootstrap.sh が未実行)" >&2
  exit 1
fi
if [ ! -f "${NEIGHBORS_FILE}" ]; then
  echo "ERROR: ${NEIGHBORS_FILE} が見つからない (vpn-router-bootstrap.sh が未完了)" >&2
  exit 1
fi

# shellcheck source=/etc/vpn-router.env
source "${VPN_ENV_FILE}"
# shellcheck source=/etc/vpn-router-neighbors.env
source "${NEIGHBORS_FILE}"

: "${ROUTER_ASN:?ROUTER_ASN is required (from ${VPN_ENV_FILE})}"
: "${PRIMARY_NEIGHBORS:?PRIMARY_NEIGHBORS is required (from ${NEIGHBORS_FILE})}"
: "${SECONDARY_NEIGHBORS:?SECONDARY_NEIGHBORS is required (from ${NEIGHBORS_FILE})}"

read -r -a PRIMARY_NEIGHBOR_ARRAY <<< "${PRIMARY_NEIGHBORS}"
read -r -a SECONDARY_NEIGHBOR_ARRAY <<< "${SECONDARY_NEIGHBORS}"

if [ "${#PRIMARY_NEIGHBOR_ARRAY[@]}" -ne 2 ] || [ "${#SECONDARY_NEIGHBOR_ARRAY[@]}" -ne 2 ]; then
  echo "ERROR: PRIMARY_NEIGHBORS / SECONDARY_NEIGHBORS はそれぞれ2つの IP であること" >&2
  exit 1
fi

ALL_NEIGHBORS=("${PRIMARY_NEIGHBOR_ARRAY[@]}" "${SECONDARY_NEIGHBOR_ARRAY[@]}")

case "${MODE}" in
  primary)
    TARGET_NEIGHBORS=("${PRIMARY_NEIGHBOR_ARRAY[@]}")
    ;;
  secondary)
    TARGET_NEIGHBORS=("${SECONDARY_NEIGHBOR_ARRAY[@]}")
    ;;
  none)
    TARGET_NEIGHBORS=()
    ;;
esac

is_target() {
  local ip="$1"
  local n
  for n in "${TARGET_NEIGHBORS[@]}"; do
    if [ "${n}" = "${ip}" ]; then
      return 0
    fi
  done
  return 1
}

ROUTE_MAP="PREFER_IN"

# vtysh に渡すコマンド列を組み立てる。
VTYSH_ARGS=(-c "configure terminal")
VTYSH_ARGS+=(-c "route-map ${ROUTE_MAP} permit 10")
VTYSH_ARGS+=(-c "set local-preference 200")
VTYSH_ARGS+=(-c "exit")
VTYSH_ARGS+=(-c "router bgp ${ROUTER_ASN} vrf vrf1")
VTYSH_ARGS+=(-c "address-family ipv4 unicast")

for neighbor in "${ALL_NEIGHBORS[@]}"; do
  if is_target "${neighbor}"; then
    VTYSH_ARGS+=(-c "neighbor ${neighbor} route-map ${ROUTE_MAP} in")
  else
    VTYSH_ARGS+=(-c "no neighbor ${neighbor} route-map ${ROUTE_MAP} in")
  fi
done

VTYSH_ARGS+=(-c "exit-address-family")
VTYSH_ARGS+=(-c "exit")
VTYSH_ARGS+=(-c "end")

echo "=== set-return-path: mode=${MODE} ==="
vtysh "${VTYSH_ARGS[@]}"

# route-map の in 適用は「今後受信する経路」にしか効かない。
# 受信済みの経路 (BGP テーブルに既に入っているもの) は再評価されないため、
# soft-reconfiguration inbound で保持している受信経路を明示的に再取り込みする。
# これを省略すると `show ip bgp` の local-preference が変化せず、
# BGP より下のレイヤー (IPsec / VTI) を疑って時間を浪費することになる。
echo "=== ソフトクリア (受信済み経路の再評価) ==="
for neighbor in "${ALL_NEIGHBORS[@]}"; do
  vtysh -c "clear bgp vrf vrf1 ${neighbor} soft in"
done

echo "=== show ip bgp vrf vrf1 ==="
vtysh -c "show ip bgp vrf vrf1"
