#!/usr/bin/env bash
#
# オンプレミス相当 VPC の VPN ルーター (Amazon Linux 2023) の初期設定。
#
# CDK Asset (S3) 経由で配信され、systemd timer (vpn-router-converge.timer) から
# 収束するまで定期的に再実行される。timer / service unit の設置は userdata 側
# (lib/constructs/on-premises-vpc.ts) の責務であり、本スクリプト自身は
# unit の設置を行わない。
#
# CloudFormation の Fn::Sub は使わない (userdata 側が事前に /etc/vpn-router.env を
# 書き出し、このスクリプトはそれを読むだけの「普通の bash」として書く)。
# そのため ${!VAR} のようなエスケープ記法は不要。
#
# primary TGW への VPN 2 本 + secondary TGW への VPN 2 本、計 4 トンネル/4 BGP セッションを終端する。
# VPN 接続は ID ではなく Name タグで検索する (primary/secondary スタックが別れており、
# ID を渡すとクロスリージョン参照が循環するため)。
#
# VPN ルーターは 2 台ある (jp 用 / us 用) が、どのリージョンが primary かはルーターごとに
# 異なる (jp 用: ap-northeast-1 が primary、us 用: us-east-1 が primary)。
# 本スクリプト自身はどちらのルーターかを意識せず、渡された変数の
# 「1番目=primary、2番目=secondary」という順序だけを前提に動く。
#
# 前提: /etc/vpn-router.env に以下の変数が書き出されていること
#   ONPREM_VPC_CIDR      例 10.100.0.0/16
#   ROUTER_ASN           例 65000
#   VPN_SEARCH_REGIONS   例 ap-northeast-1,ap-northeast-3 (1番目=primary, 2番目=secondary)
#   VPN_NAME_TAG_KEY     例 Name
#   VPN_NAME_TAG_VALUES  例 apne1-tgw-vpn,apne3-tgw-vpn (VPN_SEARCH_REGIONS と同じ順序)
#                        値はリージョンの短縮コード由来なので primary / secondary という
#                        文字列は現れない。順序だけが役割を決める
#   PRIMARY_AWS_ASN      primary 側 TGW の BGP ASN (AWS 側)
#   SECONDARY_AWS_ASN    secondary 側 TGW の BGP ASN (AWS 側)
#
# 完了状態は /run/vpn-router-status に 1 行で書く。値の一覧と意味は README.md の
# トラブルシュートの章を参照。

STATUS_FILE=/run/vpn-router-status

# 状態ファイルへの書き込み。書き込む値自体に機密情報は含まないため、
# xtrace 抑止のためのサブシェルで囲む必要はない。
write_status() {
  echo "$1" > "${STATUS_FILE}"
}

#######################################
# 0. 収束済みなら何もしない (systemd timer からの再実行用の冪等ガード)
#######################################

if [ "$(cat "${STATUS_FILE}" 2>/dev/null)" = "ok" ]; then
  echo "既に収束済み (${STATUS_FILE}=ok)。再実行をスキップする"
  exit 0
fi

set -x

ENV_FILE=/etc/vpn-router.env
if [ ! -f "${ENV_FILE}" ]; then
  echo "ERROR: ${ENV_FILE} が見つかりません。userdata が変数を書き出してから本スクリプトを呼ぶこと" >&2
  write_status failed:env-missing
  exit 1
fi
# shellcheck source=/etc/vpn-router.env
source "${ENV_FILE}"

REQUIRED_VARS=(
  ONPREM_VPC_CIDR
  ROUTER_ASN
  VPN_SEARCH_REGIONS
  VPN_NAME_TAG_KEY
  VPN_NAME_TAG_VALUES
  PRIMARY_AWS_ASN
  SECONDARY_AWS_ASN
)
for required_var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!required_var:-}" ]; then
    echo "ERROR: ${required_var} is required" >&2
    write_status failed:env-missing
    exit 1
  fi
done

# VPN_SEARCH_REGIONS / VPN_NAME_TAG_VALUES はカンマ区切り。
# 規約: 1番目=primary, 2番目=secondary として扱う (どのリージョンが primary かは
# ルーターごとに異なるため、リージョン名ではなくこの順序規約で判定する)。
IFS=',' read -r -a REGION_ARRAY <<< "${VPN_SEARCH_REGIONS}"
IFS=',' read -r -a NAME_VALUE_ARRAY <<< "${VPN_NAME_TAG_VALUES}"

if [ "${#REGION_ARRAY[@]}" -ne 2 ] || [ "${#NAME_VALUE_ARRAY[@]}" -ne 2 ]; then
  echo "ERROR: VPN_SEARCH_REGIONS と VPN_NAME_TAG_VALUES はそれぞれ2要素 (primary, secondary) であること" >&2
  write_status failed:env-missing
  exit 1
fi

PRIMARY_REGION="${REGION_ARRAY[0]}"
SECONDARY_REGION="${REGION_ARRAY[1]}"
PRIMARY_NAME_VALUE="${NAME_VALUE_ARRAY[0]}"
SECONDARY_NAME_VALUE="${NAME_VALUE_ARRAY[1]}"

#######################################
# 1. IP フォワーディングを有効化
#######################################

sysctl -w net.ipv4.ip_forward=1
if ! grep -q '^net.ipv4.ip_forward' /etc/sysctl.d/99-vpn.conf 2>/dev/null; then
  echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.d/99-vpn.conf
fi
sysctl -p /etc/sysctl.d/99-vpn.conf

#######################################
# 2. パッケージ導入
#######################################

# IPsec (Libreswan) は AL2023 標準リポジトリにある。
# FRR (BGP) は AL2023 標準リポジトリに無いため spal-release を追加してから入れる。
# strongswan も frr も dnf install だけでは "No match for argument" で失敗する
# (synth では検出できず、cloud-init のログで初めて分かる)。
# 戻り値を確認せず進むと、導入に失敗したパッケージがあっても以降の手順が
# 見かけ上進んでしまう。今回は 3 パッケージとも導入に成功していたため無害
# だったが、失敗を検知できないこと自体が欠陥のため戻り値を確認する。
if ! dnf install -y jq libreswan; then
  echo "ERROR: dnf install (jq libreswan) に失敗した" >&2
  write_status failed:package-install
  exit 1
fi
if ! dnf install -y spal-release; then
  echo "ERROR: dnf install (spal-release) に失敗した" >&2
  write_status failed:package-install
  exit 1
fi
if ! dnf install -y frr; then
  echo "ERROR: dnf install (frr) に失敗した" >&2
  write_status failed:package-install
  exit 1
fi

#######################################
# 3. FRR デーモン設定
#######################################

sed -i "s/bgpd=.*/bgpd=yes/g" /etc/frr/daemons

# zebra に -n フラグを追加して netns バックエンドを有効化する。
# これが無いと vrf-id が -1 になり BGP セッションが確立しない。
sed -i 's/zebra_options=" *-A/zebra_options=" -n -A/g' /etc/frr/daemons

#######################################
# 4. Libreswan 初期化
#######################################

ipsec initnss || true

#######################################
# 5. IMDSv2 でインスタンス情報を取得
#######################################

TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 1800")
CGW_IP_ADDRESS=$(curl -s -H "X-aws-ec2-metadata-token: ${TOKEN}" \
  http://169.254.169.254/latest/meta-data/public-ipv4)
CGW_PRIVATE_IP_ADDRESS=$(curl -s -H "X-aws-ec2-metadata-token: ${TOKEN}" \
  http://169.254.169.254/latest/meta-data/local-ipv4)

if [ -z "${CGW_IP_ADDRESS}" ] || [ -z "${CGW_PRIVATE_IP_ADDRESS}" ]; then
  echo "ERROR: IMDS から public-ipv4 / local-ipv4 を取得できなかった" >&2
  write_status failed:imds
  exit 1
fi

#######################################
# 6. VPN 接続情報を Name タグで検索 (primary 側 2 本 + secondary 側 2 本)
#######################################

# リージョンごとに describe-vpn-connections を呼び、4 トンネル分揃うまで待つ。
# トンネル情報は連想配列で蓄積する。キーは "primary1" "primary2" "secondary1" "secondary2"。
declare -A TUNNEL_OUTSIDE_IP
declare -A TUNNEL_INSIDE_CIDR
declare -A TUNNEL_PSK
declare -A TUNNEL_AWS_ASN
declare -A REGION_OUTSIDE_IPS  # primary / secondary -> スペース区切りの外側 IP 2 本

fetch_region_tunnels() {
  # 関数の先頭で `local -` してから `set +x` する。これにより、この関数が
  # (return 1 を含むどの経路で) 抜けても、trace の on/off 状態が呼び出し元の
  # 状態へ自動的に復元される。
  #
  # 過去に「jq 呼び出しをサブシェル ( set +x; ... ) で囲む」方式で対策した
  # ことがあるが、実機と再現実験の両方でこれが機能しないことを確認した。
  # `var=$(func_call "${secret}")` という形は、
  #   1. 関数呼び出しの引数 (`"${secret}"` の展開値) を、呼び出し元
  #      (この関数、trace 有効) の trace がそのまま出力する
  #   2. 代入 `var=...` 自体も、呼び出し元の trace 状態で記録される
  # 関数の中身をサブシェルで trace 抑止しても、この 2 か所には効かない。
  # 呼び出し元であるこの関数自身の trace を止めるしかない。
  local -
  set +x

  local region="$1"
  local name_value="$2"
  local label="$3" # primary / secondary

  # AWS CLI のエラーは握りつぶさず標準エラーへ流す。API 権限不足やリージョン指定ミスを
  # 「VPN 接続が見つからない」と誤診すると原因の切り分けに時間がかかるため
  local json
  json=$(aws ec2 describe-vpn-connections \
    --region "${region}" \
    --filters "Name=tag:${VPN_NAME_TAG_KEY},Values=${name_value}" "Name=state,Values=available" \
    --no-cli-pager) || {
    echo "  ${label}: describe-vpn-connections が失敗した (region=${region})" >&2
    return 1
  }

  local count
  count=$(echo "${json}" | jq -r '.VpnConnections | length' 2>/dev/null || echo 0)
  if [ "${count}" != "1" ]; then
    echo "  ${label}: VPN 接続が見つからない (region=${region}, tag=${VPN_NAME_TAG_KEY}=${name_value}, count=${count})"
    return 1
  fi

  local vpn_conn
  vpn_conn=$(echo "${json}" | jq -c '.VpnConnections[0]')

  local aws_asn
  if [ "${label}" = "primary" ]; then
    aws_asn="${PRIMARY_AWS_ASN}"
  else
    aws_asn="${SECONDARY_AWS_ASN}"
  fi

  local outside_ips=""
  for i in 0 1; do
    local tnum=$((i + 1))
    local key="${label}${tnum}"

    local outside_ip
    outside_ip=$(echo "${vpn_conn}" | jq -r ".Options.TunnelOptions[${i}].OutsideIpAddress")
    local inside_cidr
    inside_cidr=$(echo "${vpn_conn}" | jq -r ".Options.TunnelOptions[${i}].TunnelInsideCidr")

    # 事前共有鍵は describe-vpn-connections の応答フィールドから取る。
    # 取れない場合は明示的に失敗として扱う (XML へのフォールバックは持たない)。
    local psk
    psk=$(echo "${vpn_conn}" | jq -r ".Options.TunnelOptions[${i}].PreSharedKey // empty")

    if [ -z "${outside_ip}" ] || [ "${outside_ip}" = "null" ] || \
       [ -z "${inside_cidr}" ] || [ "${inside_cidr}" = "null" ] || \
       [ -z "${psk}" ]; then
      echo "  ${label}${tnum}: 必要な値が揃っていない (outside_ip=${outside_ip}, inside_cidr=${inside_cidr}, psk_empty=$([ -z "${psk}" ] && echo yes || echo no))"
      return 1
    fi

    TUNNEL_OUTSIDE_IP["${key}"]="${outside_ip}"
    TUNNEL_INSIDE_CIDR["${key}"]="${inside_cidr}"
    TUNNEL_PSK["${key}"]="${psk}"
    TUNNEL_AWS_ASN["${key}"]="${aws_asn}"
    outside_ips="${outside_ips}${outside_ips:+ }${outside_ip}"
  done

  REGION_OUTSIDE_IPS["${label}"]="${outside_ips}"
  return 0
}

echo "VPN 接続 (4 トンネル分) が揃うまで待機する"
MAX_TRIES=60
TRY=0
while [ "${TRY}" -lt "${MAX_TRIES}" ]; do
  TRY=$((TRY + 1))
  if fetch_region_tunnels "${PRIMARY_REGION}" "${PRIMARY_NAME_VALUE}" "primary" && \
     fetch_region_tunnels "${SECONDARY_REGION}" "${SECONDARY_NAME_VALUE}" "secondary"; then
    echo "4 トンネル分の情報を取得できた (${TRY}回目)"
    break
  fi
  echo "VPN 接続情報の取得待機中... (${TRY}/${MAX_TRIES})"
  sleep 10
done

if [ "${#TUNNEL_OUTSIDE_IP[@]}" -ne 4 ]; then
  echo "ERROR: 4 トンネル分の VPN 接続情報を取得できなかった" >&2
  write_status failed:vpn-lookup
  exit 1
fi

#######################################
# 7. libreswan の PSK ファイル生成
#######################################

# xtrace が有効なままだと heredoc の中身 (PSK 本体) がそのまま
# /var/log/cloud-init-output.log に出るため、サブシェル内で trace を止めてから書く。
(
  set +x
  cat <<EOF > /etc/ipsec.d/cloudwan.secrets
${CGW_IP_ADDRESS} ${TUNNEL_OUTSIDE_IP[primary1]} : PSK "${TUNNEL_PSK[primary1]}"
${CGW_IP_ADDRESS} ${TUNNEL_OUTSIDE_IP[primary2]} : PSK "${TUNNEL_PSK[primary2]}"
${CGW_IP_ADDRESS} ${TUNNEL_OUTSIDE_IP[secondary1]} : PSK "${TUNNEL_PSK[secondary1]}"
${CGW_IP_ADDRESS} ${TUNNEL_OUTSIDE_IP[secondary2]} : PSK "${TUNNEL_PSK[secondary2]}"
EOF
)
chmod 600 /etc/ipsec.d/cloudwan.secrets

#######################################
# 8. libreswan のトンネル設定生成 (4 conn)
#######################################

gen_conn() {
  local name="$1"
  local right="$2"
  local mark="$3"
  local vti="$4"
  cat <<EOF
conn ${name}
  type=tunnel
  auto=start
  authby=secret
  ikev2=insist
  ike=aes256-sha2_256;dh14
  esp=aes256-sha2_256;dh14
  ikelifetime=28800s
  salifetime=3600s
  rekey=yes
  dpddelay=10
  dpdtimeout=30
  dpdaction=restart
  left=${CGW_PRIVATE_IP_ADDRESS}
  leftid=${CGW_IP_ADDRESS}
  leftsubnet=0.0.0.0/0
  right=${right}
  rightid=${right}
  rightsubnet=0.0.0.0/0
  mark=${mark}/0xffffffff
  vti-interface=${vti}
  vti-routing=no

EOF
}

{
  gen_conn tunnel1 "${TUNNEL_OUTSIDE_IP[primary1]}" 100 vti1
  gen_conn tunnel2 "${TUNNEL_OUTSIDE_IP[primary2]}" 200 vti2
  gen_conn tunnel3 "${TUNNEL_OUTSIDE_IP[secondary1]}" 300 vti3
  gen_conn tunnel4 "${TUNNEL_OUTSIDE_IP[secondary2]}" 400 vti4
} > /etc/ipsec.d/cloudwan.conf

#######################################
# 8.5. network namespace vrf1 の定義 (VTI 存在確認より前に必要)
#######################################

# NAMESPACE と ip netns add はここで前倒しする。VPN やトンネルの状態とは
# 無関係な定義だが、後述のとおりセクション 10 (VTI 作成待ち) が vrf1 の中も
# 見に行く必要があり、その時点で vrf1 が存在している必要があるため。
NAMESPACE=vrf1
ip netns add "${NAMESPACE}" 2>/dev/null || true

#######################################
# 9. IPsec 起動 + 4 トンネル接続 (リトライ付き)
#######################################

systemctl enable ipsec
systemctl restart ipsec
sleep 5

IPSEC_FAILED_TUNNELS=""
for conn in tunnel1 tunnel2 tunnel3 tunnel4; do
  CONN_ESTABLISHED=0
  for i in $(seq 1 30); do
    if ipsec auto --up "${conn}" 2>&1 | grep -q "established"; then
      echo "${conn} established"
      CONN_ESTABLISHED=1
      break
    fi
    echo "${conn} 接続試行中... (${i}/30)"
    sleep 10
  done
  if [ "${CONN_ESTABLISHED}" != "1" ]; then
    IPSEC_FAILED_TUNNELS="${IPSEC_FAILED_TUNNELS}${IPSEC_FAILED_TUNNELS:+ }${conn}"
  fi
done

# 30 回試しても establish しなかったトンネルが 1 本でもあれば、ここで止める。
# 素通りして先へ進むと、IPsec が 1 本も張れていなくても後続の VTI 作成待ちや
# FRR 起動を経て write_status ok に到達してしまい、冪等ガード (0 番) が
# それを見て以降の再実行を永久に止める。これは今回の障害の欠陥 2 (収束用
# timer が設置されず二度と再試行されなかった) と同じ結末を、新しい仕組みの
# 中に作り込むことになるため、必ずここで検知して exit する。
if [ -n "${IPSEC_FAILED_TUNNELS}" ]; then
  echo "ERROR: 以下のトンネルが established にならなかった: ${IPSEC_FAILED_TUNNELS}" >&2
  write_status failed:ipsec-up
  exit 1
fi

#######################################
# 10. VTI 作成待ち (4 本)
#######################################

# VTI は root namespace で作られた直後に (再実行時は既に) vrf1 namespace へ
# 移動していることがある。ネットワークデバイスの netns 所属は ipsec サービスの
# 再起動をまたいで維持されるため、セクション 11/12 まで一度到達した後の
# 2 回目以降の実行では、systemctl restart ipsec 後の VTI は最初から vrf1 の
# 中にあり、root namespace には存在しない。これは異常ではなく、セクション
# 11/12 が目指す最終状態そのものである。root namespace しか見ないと、この
# 正常な状態を「VTI が作成されていない」と誤認して failed:vti に落ち、
# 一度でもセクション 12 を通過した後は systemd timer の再試行が永久に
# 機能しなくなる (今回の障害と同じ結末)。root / vrf1 のどちらかに存在すれば
# 成功とみなす。
vti_exists() {
  local vti="$1"
  ip link show "${vti}" > /dev/null 2>&1 || \
    ip netns exec "${NAMESPACE}" ip link show "${vti}" > /dev/null 2>&1
}

VTI_READY=0
for i in $(seq 1 30); do
  if vti_exists vti1 && vti_exists vti2 && vti_exists vti3 && vti_exists vti4; then
    echo "4 VTI デバイスの作成完了"
    VTI_READY=1
    break
  fi
  echo "VTI 作成待機中... (${i}/30)"
  sleep 2
done

# IPsec と同じ理由で、30 回試しても 4 本揃わなければここで止める。
if [ "${VTI_READY}" != "1" ]; then
  MISSING_VTIS=""
  for vti in vti1 vti2 vti3 vti4; do
    if ! vti_exists "${vti}"; then
      MISSING_VTIS="${MISSING_VTIS}${MISSING_VTIS:+ }${vti}"
    fi
  done
  echo "ERROR: 以下の VTI デバイスが作成されなかった: ${MISSING_VTIS}" >&2
  write_status failed:vti
  exit 1
fi

#######################################
# 11. eth1 を vrf1 へ移動
#######################################

# NAMESPACE の定義と ip netns add はセクション 8.5 (セクション 10 の VTI
# 存在確認が vrf1 の中も見に行く必要があるため) に前倒し済み。ここでの
# 再定義はしない。

# AL2023 のインタフェース名は ens5 / ens6 で固定できないため、
# IMDS の device-number からインタフェース名を動的に特定する。
#
# VTI (セクション 10) と同じ理由で、この MAC 照合は root namespace だけでなく
# vrf1 namespace も見る必要がある。eth1 が既に vrf1 へ移動済みの 2 回目以降の
# 実行では、`ip link set iface netns vrf1` によってその interface は root
# namespace の一覧から完全に消えている (netns 間移動の仕様上、両方に同時に
# 見えることはない)。root namespace の `ip -o link` だけを見ると、既に正しく
# 移動済みであるにもかかわらず「device-number=1 のインタフェースが見つからない」
# と誤認して failed:eth1 に落ちる。VTI と同じクラスの欠陥のため、同じ考え方
# (root / vrf1 のどちらかで見つかれば成功) で対処する。
find_iface_by_mac() {
  local mac="$1"
  local iface
  iface=$(ip -o link | grep -i "${mac}" | awk -F': ' '{print $2}')
  if [ -z "${iface}" ]; then
    iface=$(ip netns exec "${NAMESPACE}" ip -o link 2>/dev/null | grep -i "${mac}" | awk -F': ' '{print $2}')
  fi
  echo "${iface}"
}

ETH1_IFACE=""
ETH1_IP=""
for mac in $(curl -s -H "X-aws-ec2-metadata-token: ${TOKEN}" \
  http://169.254.169.254/latest/meta-data/network/interfaces/macs/ | tr -d '/'); do
  dn=$(curl -s -H "X-aws-ec2-metadata-token: ${TOKEN}" \
    "http://169.254.169.254/latest/meta-data/network/interfaces/macs/${mac}/device-number")
  if [ "${dn}" = "1" ]; then
    ETH1_IFACE=$(find_iface_by_mac "${mac}")
    ETH1_IP=$(curl -s -H "X-aws-ec2-metadata-token: ${TOKEN}" \
      "http://169.254.169.254/latest/meta-data/network/interfaces/macs/${mac}/local-ipv4s")
    echo "DeviceIndex 1 = ${ETH1_IFACE} (MAC: ${mac}, IP: ${ETH1_IP})"
    break
  fi
done

if [ -z "${ETH1_IFACE}" ]; then
  echo "ERROR: device-number=1 のインタフェースが見つからなかった" >&2
  write_status failed:eth1
  exit 1
fi

if ! ip netns exec "${NAMESPACE}" ip link show "${ETH1_IFACE}" > /dev/null 2>&1; then
  ip link set "${ETH1_IFACE}" netns "${NAMESPACE}" up
  # netns への移動が成功したことを確認する。ここを確認せずに進むと、移動が
  # 失敗していても後続の FRR 起動を経て write_status ok に到達してしまう。
  # FRR 設定は vrf vrf1 / netns /run/netns/vrf1 を前提にしており、
  # eth1 が vrf1 に入らないままだと該当インタフェース側の BGP ネイバーは
  # 永久に確立しない (IPsec / VTI と同じく FRR が自己回復できる種類の
  # 失敗ではない)。
  if ! ip netns exec "${NAMESPACE}" ip link show "${ETH1_IFACE}" > /dev/null 2>&1; then
    echo "ERROR: ${ETH1_IFACE} を ${NAMESPACE} へ移動できなかった" >&2
    write_status failed:eth1
    exit 1
  fi
  ip netns exec "${NAMESPACE}" ip addr add "${ETH1_IP}/24" dev "${ETH1_IFACE}" 2>/dev/null || true
fi

#######################################
# 12. VTI を vrf1 へ移動 + トンネル内側 IP を付与
#######################################

# /30 の network+1 が AWS 側、network+2 が CGW 側。
calc_tunnel_ips() {
  local cidr="$1"
  local net
  net=$(echo "${cidr}" | cut -d/ -f1 | awk -F. '{printf "%s.%s.%s.%d", $1, $2, $3, int($4/4)*4}')
  local aws_ip
  aws_ip=$(echo "${net}" | awk -F. '{printf "%s.%s.%s.%d", $1, $2, $3, $4+1}')
  local cgw_ip
  cgw_ip=$(echo "${net}" | awk -F. '{printf "%s.%s.%s.%d", $1, $2, $3, $4+2}')
  echo "${aws_ip} ${cgw_ip}"
}

declare -A TUNNEL_AWS_IP

move_vti_and_assign_ip() {
  local vti="$1"
  local key="$2"

  read -r aws_ip cgw_ip <<< "$(calc_tunnel_ips "${TUNNEL_INSIDE_CIDR[${key}]}")"
  TUNNEL_AWS_IP["${key}"]="${aws_ip}"

  if ! ip netns exec "${NAMESPACE}" ip link show "${vti}" > /dev/null 2>&1; then
    ip link set "${vti}" netns "${NAMESPACE}"
    # eth1 と同じ理由で、netns への移動が成功したことを確認してから進む。
    if ! ip netns exec "${NAMESPACE}" ip link show "${vti}" > /dev/null 2>&1; then
      echo "ERROR: ${vti} を ${NAMESPACE} へ移動できなかった" >&2
      write_status failed:vti
      exit 1
    fi
  fi
  ip netns exec "${NAMESPACE}" ip link set "${vti}" up mtu 1436
  ip netns exec "${NAMESPACE}" ip addr add "${cgw_ip}/30" dev "${vti}" 2>/dev/null || true
}

move_vti_and_assign_ip vti1 primary1
move_vti_and_assign_ip vti2 primary2
move_vti_and_assign_ip vti3 secondary1
move_vti_and_assign_ip vti4 secondary2

#######################################
# 13. ネイバー / リージョン対応表と外側 IP 対応表の書き出し
#######################################

cat <<EOF > /etc/vpn-router-neighbors.env
PRIMARY_NEIGHBORS="${TUNNEL_AWS_IP[primary1]} ${TUNNEL_AWS_IP[primary2]}"
SECONDARY_NEIGHBORS="${TUNNEL_AWS_IP[secondary1]} ${TUNNEL_AWS_IP[secondary2]}"
EOF

# fail-primary-vpn.sh / restore-primary-vpn.sh が参照する外側 IP 対応表。
cat <<EOF > /etc/vpn-router-outside-ips.env
PRIMARY_OUTSIDE_IPS="${REGION_OUTSIDE_IPS[primary]}"
SECONDARY_OUTSIDE_IPS="${REGION_OUTSIDE_IPS[secondary]}"
EOF

#######################################
# 14. FRR (BGP) 設定生成 (4 ネイバー、リージョンごとに remote-as が異なる)
#######################################

cat <<EOF > /etc/frr/frr.conf
frr version 10.4
frr defaults traditional
hostname vpn-router
log syslog informational
no ipv6 forwarding
!
vrf vrf1
 netns /run/netns/vrf1
exit-vrf
!
router bgp ${ROUTER_ASN} vrf vrf1
 no bgp ebgp-requires-policy
 neighbor ${TUNNEL_AWS_IP[primary1]} remote-as ${TUNNEL_AWS_ASN[primary1]}
 neighbor ${TUNNEL_AWS_IP[primary1]} ebgp-multihop 255
 neighbor ${TUNNEL_AWS_IP[primary2]} remote-as ${TUNNEL_AWS_ASN[primary2]}
 neighbor ${TUNNEL_AWS_IP[primary2]} ebgp-multihop 255
 neighbor ${TUNNEL_AWS_IP[secondary1]} remote-as ${TUNNEL_AWS_ASN[secondary1]}
 neighbor ${TUNNEL_AWS_IP[secondary1]} ebgp-multihop 255
 neighbor ${TUNNEL_AWS_IP[secondary2]} remote-as ${TUNNEL_AWS_ASN[secondary2]}
 neighbor ${TUNNEL_AWS_IP[secondary2]} ebgp-multihop 255
 !
 address-family ipv4 unicast
  redistribute connected
  aggregate-address ${ONPREM_VPC_CIDR} summary-only
  neighbor ${TUNNEL_AWS_IP[primary1]} soft-reconfiguration inbound
  neighbor ${TUNNEL_AWS_IP[primary2]} soft-reconfiguration inbound
  neighbor ${TUNNEL_AWS_IP[secondary1]} soft-reconfiguration inbound
  neighbor ${TUNNEL_AWS_IP[secondary2]} soft-reconfiguration inbound
  neighbor ${TUNNEL_AWS_IP[primary1]} route-map ALLOW_OUT out
  neighbor ${TUNNEL_AWS_IP[primary2]} route-map ALLOW_OUT out
  neighbor ${TUNNEL_AWS_IP[secondary1]} route-map ALLOW_OUT out
  neighbor ${TUNNEL_AWS_IP[secondary2]} route-map ALLOW_OUT out
 exit-address-family
exit
!
ip prefix-list LOCAL seq 5 permit ${ONPREM_VPC_CIDR}
!
route-map ALLOW_OUT permit 10
 match ip address prefix-list LOCAL
exit
!
end
EOF

#######################################
# 15. FRR 起動
#######################################

systemctl enable frr
systemctl restart frr

# ok の意味は「IPsec 4 本 + VTI 4 本 + FRR 起動まで完了」であり、FRR 起動が
# その条件の 1 つである以上、restart コマンドの発行だけでなく実際に
# active になったことを確認する。frr.conf の構文エラーなど restart 自体が
# 失敗するケースは BGP セッションが自己回復する話ではなく (サービスが
# 落ちている以上、何度待っても回復しない)、IPsec / VTI と同じ「このスクリプトが
# 作るもの」に分類されるため、同じ扱いで検知して exit する。
if ! systemctl is-active --quiet frr; then
  echo "ERROR: frr サービスの起動に失敗した" >&2
  write_status failed:frr
  exit 1
fi

#######################################
# 16. 収束完了を状態ファイルに記録する
#######################################

# 収束用 systemd timer の設置は userdata 側 (lib/constructs/on-premises-vpc.ts) の
# 責務にする。本スクリプトには exit 1 で終了する経路が複数あり、その手前で
# タイマーを設置すると途中で失敗したときに二度と再試行されなくなるため。

write_status ok

echo "vpn-router-bootstrap.sh 完了"
