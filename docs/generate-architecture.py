#!/usr/bin/env python3
"""検証環境の構成図を生成する。座標はすべて式で計算する (目分量禁止)。

配置の方針
  - 上段に jp ペア、中央に Cloud WAN、下段に us ペアを置き、Cloud WAN を挟んで線対称にする
    上段は下段を上下反転させ、Transit Gateway は常に Cloud WAN 側を向く
  - Core Network Edge は Cloud WAN の枠の中に置く
  - リージョン内の列は VPN 線が交差 / 迂回しないように並べる
      primary  : [Cloud WAN 直アタッチ VPC] [TGW 配下 VPC] [オンプレミス相当 VPC]
      secondary: [TGW 配下 VPC] [Cloud WAN 直アタッチ VPC]
  - VPN はルーターから Cloud WAN 側へ 2 本の平行な縦線で抜け、それぞれの TGW へ入る
"""
import os
from html import escape

# ---- カタログ由来のスタイル (references/aws-style-catalog.md からコピー) ----
G_REGION = ("points=[[0,0],[1,0],[1,1],[0,1]];outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;"
            "fontSize=12;container=0;collapsible=0;shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_region;"
            "strokeColor=#00A4A6;fillColor=none;verticalAlign=top;align=left;spacingLeft=30;fontColor=#147EBA;dashed=1;")
G_VPC = ("sketch=0;outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=11;fontStyle=0;"
         "shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_vpc2;strokeColor=#8C4FFF;fillColor=none;"
         "verticalAlign=top;align=left;spacingLeft=30;fontColor=#8C4FFF;dashed=0;")
G_PUB = ("sketch=0;outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=10;fontStyle=0;"
         "shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_security_group;grStroke=0;strokeColor=#7AA116;"
         "fillColor=#F2F6E8;verticalAlign=top;align=left;spacingLeft=30;fontColor=#248814;dashed=0;")
G_PRIV = ("sketch=0;outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=10;fontStyle=0;"
          "shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_security_group;grStroke=0;strokeColor=#00A4A6;"
          "fillColor=#E6F6F7;verticalAlign=top;align=left;spacingLeft=30;fontColor=#147EBA;dashed=0;")
G_NOTE = ("rounded=0;fillColor=none;strokeColor=#5A6C86;dashed=0;verticalAlign=top;align=left;spacingLeft=10;"
          "spacingTop=4;fontColor=#232F3E;fontSize=12;fontStyle=1;html=1;")
G_DASH = ("rounded=1;fillColor=none;strokeColor=#8C4FFF;dashed=1;dashPattern=2 4;verticalAlign=top;align=left;"
          "spacingLeft=14;spacingTop=4;fontColor=#8C4FFF;fontSize=12;html=1;")
G_CLOUD = ("rounded=1;fillColor=none;strokeColor=#232F3E;dashed=0;verticalAlign=top;align=left;spacingLeft=12;"
           "spacingTop=4;fontColor=#232F3E;fontSize=13;html=1;")

# resourceIcon (塗りつぶしの四角)。末尾の shape=mxgraph.aws4.resourceIcon; を落とすとベタ塗りになる
_PTS = ("points=[[0,0,0],[0.25,0,0],[0.5,0,0],[0.75,0,0],[1,0,0],[0,1,0],[0.25,1,0],[0.5,1,0],[0.75,1,0],"
        "[1,1,0],[0,0.25,0],[0,0.5,0],[0,0.75,0],[1,0.25,0],[1,0.5,0],[1,0.75,0]];")
def icon(name, color):
    return ("sketch=0;" + _PTS + "outlineConnect=0;fontColor=#232F3E;fillColor=" + color +
            ";strokeColor=#ffffff;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;"
            "html=1;fontSize=11;fontStyle=0;aspect=fixed;shape=mxgraph.aws4.resourceIcon;"
            "resIcon=mxgraph.aws4." + name + ";")
# 線画シェイプ。Cloud WAN 系は draw.io のパレットで次の名前が実在する (実機の Sidebar-AWS4.js で確認)
#   cloud_wan_virtual_pop                            = Cloud WAN Core Network Edge
#   cloud_wan_segment_network                        = Cloud WAN Segment Network
#   cloud_wan_transit_gateway_route_table_attachment = Cloud WAN TGW Route Table Attachment
def line_art(name, label_pos="bottom", size=11):
    return ("sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#8C4FFF;strokeColor=none;"
            f"dashed=0;verticalLabelPosition={label_pos};verticalAlign={'top' if label_pos=='bottom' else 'bottom'};"
            f"align=center;html=1;fontSize={size};fontStyle=0;aspect=fixed;pointerEvents=1;"
            "shape=mxgraph.aws4." + name + ";")
NET, COMPUTE = "#8C4FFF", "#ED7100"
E_ATT = ("edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;startArrow=none;"
         "strokeColor=#8C4FFF;strokeWidth=1.5;fontSize=10;")
E_VPN = ("edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;startArrow=none;"
         "strokeColor=#232F3E;strokeWidth=1.5;fontSize=10;")
TXT = "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=top;whiteSpace=wrap;fontSize=11;"

cells, _n = [], [0]
def nid():
    _n[0] += 1
    return "n%d" % _n[0]
def box(x, y, w, h, style, label=""):
    v = escape(label).replace("\n", "&lt;br&gt;")
    cells.append(f'<mxCell id="{nid()}" value="{v}" style="{style}" vertex="1" parent="1">'
                 f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
def edge(pts, style):
    a = f'<mxPoint x="{pts[0][0]}" y="{pts[0][1]}" as="sourcePoint"/>'
    b = f'<mxPoint x="{pts[-1][0]}" y="{pts[-1][1]}" as="targetPoint"/>'
    mids = "".join(f'<mxPoint x="{x}" y="{y}"/>' for x, y in pts[1:-1])
    arr = f'<Array as="points">{mids}</Array>' if mids else ""
    cells.append(f'<mxCell id="{nid()}" value="" style="{style}" edge="1" parent="1">'
                 f'<mxGeometry relative="1" as="geometry">{a}{b}{arr}</mxGeometry></mxCell>')

ROWS = [
    [dict(region="ap-northeast-1", cne=64520, tgw=64512, cw="10.0.0.0/16", tv="10.10.0.0/16", role="primary",
          onprem=dict(vpc="10.100.0.0/16", pub="10.100.0.0/24", pri="10.100.1.0/24", asn=65000),
          tun=("169.254.10.0/30", "169.254.10.4/30")),
     dict(region="ap-northeast-3", cne=64521, tgw=64513, cw="10.1.0.0/16", tv="10.11.0.0/16", role="secondary",
          onprem=None, tun=("169.254.20.0/30", "169.254.20.4/30"))],
    [dict(region="us-east-1", cne=64522, tgw=64514, cw="10.2.0.0/16", tv="10.12.0.0/16", role="primary",
          onprem=dict(vpc="10.200.0.0/16", pub="10.200.0.0/24", pri="10.200.1.0/24", asn=65001),
          tun=("169.254.30.0/30", "169.254.30.4/30")),
     dict(region="us-west-2", cne=64523, tgw=64515, cw="10.3.0.0/16", tv="10.13.0.0/16", role="secondary",
          onprem=None, tun=("169.254.40.0/30", "169.254.40.4/30"))],
]

# ---- レイアウト定数 ----
X0, PAD, COLW, COLGAP, ONPW = 40, 30, 200, 50, 280
VPCH, ONPH, IC = 180, 270, 48
RGAP, ROWGAP = 60, 56
ICON_DY, VPC_DY = 34, 142          # Cloud WAN 側の辺からの距離
ROW_H = VPC_DY + ONPH + 30
CLOUD_H = 280
ROW_Y = [40, 40 + ROW_H + ROWGAP + CLOUD_H + ROWGAP]
CLOUD_Y = 40 + ROW_H + ROWGAP
FLIP = [True, False]               # 上段だけ上下反転

rw = lambda r: PAD * 2 + COLW * 2 + COLGAP + ((COLGAP + ONPW) if r["onprem"] else 0)
RX = [[X0] * len(row) for row in ROWS]
for i, row in enumerate(ROWS):
    for j in range(1, len(row)):
        RX[i][j] = RX[i][j - 1] + rw(row[j - 1]) + RGAP
TOTAL_W = max(RX[i][-1] + rw(row[-1]) for i, row in enumerate(ROWS)) - X0

def cols(i, j):
    b = RX[i][j] + PAD
    if ROWS[i][j]["role"] == "primary":
        return b, b + COLW + COLGAP, b + (COLW + COLGAP) * 2
    return b + COLW + COLGAP, b, None
cne_cx = lambda i, j: cols(i, j)[0] + COLW // 2
tgw_cx = lambda i, j: cols(i, j)[1] + COLW // 2

# ---- Cloud WAN (中央の層)。Core Network Edge はこの枠の中に置く ----
box(X0, CLOUD_Y, TOTAL_W, CLOUD_H, G_CLOUD, "AWS Cloud WAN")
box(X0 + 16, CLOUD_Y + 30, TOTAL_W - 32, CLOUD_H - 44, G_DASH, "セグメント: verification")
CNE_Y = [CLOUD_Y + 64, CLOUD_Y + 192]      # 上段 (jp) 用 / 下段 (us) 用

for i, row in enumerate(ROWS):
    ry, flip = ROW_Y[i], FLIP[i]
    icon_y = ry + (ROW_H - ICON_DY - IC if flip else ICON_DY)
    vpc_y_std = ry + (ROW_H - VPC_DY - VPCH if flip else VPC_DY)
    vpc_y_onp = ry + (ROW_H - VPC_DY - ONPH if flip else VPC_DY)
    sub_y, sub_h = vpc_y_std + 42, VPCH - 60
    ec2_y = sub_y + (sub_h - IC) // 2 + 4
    y_icon = icon_y + IC // 2
    cne_y = CNE_Y[i]
    cne_edge_y = cne_y if flip else cne_y + IC         # Cloud WAN 枠から出る辺
    # オンプレミス相当 VPC の内訳。Private を Cloud WAN から遠い側、Public を Cloud WAN 側に置く
    PRI_DY, PUB_DY, RT_DY = (44, 168, 162) if flip else (142, 42, 136)

    for j, r in enumerate(row):
        cw_x, tv_x, op_x = cols(i, j)
        box(RX[i][j], ry, rw(r), ROW_H, G_REGION, r["region"])
        box(cne_cx(i, j) - IC // 2, cne_y, IC, IC,
            line_art("cloud_wan_virtual_pop", "bottom" if flip else "top"),
            f'Core Network Edge\n{r["region"]}  ASN {r["cne"]}')
        box(tgw_cx(i, j) - IC // 2, icon_y, IC, IC, icon("transit_gateway", NET),
            f'Transit Gateway\nASN {r["tgw"]}')
        for vx, title, cidr in ((cw_x, "Cloud WAN 直アタッチ VPC", r["cw"]), (tv_x, "TGW 配下 VPC", r["tv"])):
            box(vx, vpc_y_std, COLW, VPCH, G_VPC, f"{title}\n{cidr}")
            box(vx + 10, sub_y, COLW - 20, sub_h, G_PUB, "Public Subnet /24")
            box(vx + COLW // 2 - IC // 2, ec2_y, IC, IC, icon("ec2", COMPUTE), "確認用 EC2")
        # CNE から Cloud WAN 直アタッチ VPC の EC2 へ (縦一直線)
        edge([(cne_cx(i, j), cne_edge_y), (cne_cx(i, j), ec2_y + (IC if flip else 0))], E_ATT)
        # CNE と TGW の peering。CNE アイコンの横から出し、中間で折れて TGW の横へ入る
        sgn_x = 1 if tgw_cx(i, j) > cne_cx(i, j) else -1
        x_mid = (cne_cx(i, j) + tgw_cx(i, j)) // 2
        edge([(cne_cx(i, j) + sgn_x * (IC // 2), cne_y + IC // 2), (x_mid, cne_y + IC // 2),
              (x_mid, y_icon), (tgw_cx(i, j) - sgn_x * (IC // 2), y_icon)], E_ATT)
        # TGW から TGW 配下 VPC の EC2 へ
        edge([(tgw_cx(i, j), icon_y if flip else icon_y + IC),
              (tgw_cx(i, j), ec2_y + (IC if flip else 0))], E_ATT)
        # オンプレミス相当 VPC (右端の列)。反転時は Public / Private の上下も入れ替える
        if r["onprem"]:
            o = r["onprem"]
            box(op_x, vpc_y_onp, ONPW, ONPH, G_VPC, f'オンプレミス相当 VPC\n{o["vpc"]}')
            box(op_x + 10, vpc_y_onp + PUB_DY, ONPW - 20, 88, G_PUB, f'Public Subnet {o["pub"]}')
            box(op_x + 10, vpc_y_onp + PRI_DY, ONPW - 20, 112, G_PRIV, f'Private Subnet {o["pri"]}')
            box(op_x + ONPW - 78 - IC // 2, vpc_y_onp + RT_DY - IC // 2, IC, IC, icon("ec2", COMPUTE),
                f'VPN ルーター\nASN {o["asn"]}')
            box(op_x + 24, vpc_y_onp + PRI_DY + 34, IC, IC, icon("ec2", COMPUTE), "確認用 EC2")

    # ---- Site-to-Site VPN。ルーターから Cloud WAN 側へ 2 本の平行な縦線で抜ける ----
    prim, sec = row[0], row[1]
    op_x = cols(i, 0)[2]
    rt_cx = op_x + ONPW - 78
    rt_edge_y = vpc_y_onp + RT_DY + (IC // 2 if flip else -IC // 2)
    edge([(rt_cx - 12, rt_edge_y), (rt_cx - 12, y_icon), (tgw_cx(i, 0) + IC // 2, y_icon)], E_VPN)
    edge([(rt_cx + 12, rt_edge_y), (rt_cx + 12, y_icon), (tgw_cx(i, 1) - IC // 2, y_icon)], E_VPN)
    lbl_y = y_icon + (-44 if flip else 8)
    box(tgw_cx(i, 0) + IC // 2 + 12, lbl_y, rt_cx - tgw_cx(i, 0) - IC // 2 - 40, 34, TXT,
        f'Site-to-Site VPN\n{prim["tun"][0]} / {prim["tun"][1]}')
    box(rt_cx + 26, lbl_y, tgw_cx(i, 1) - IC // 2 - rt_cx - 44, 34, TXT + "align=right;",
        f'Site-to-Site VPN\n{sec["tun"][0]} / {sec["tun"][1]}')

# ---- 凡例 / 注記 ----
NY = ROW_Y[-1] + ROW_H + 56
box(X0, NY, 300, 112, G_NOTE, "凡例")
edge([(X0 + 24, NY + 44), (X0 + 94, NY + 44)], E_ATT)
box(X0 + 104, NY + 34, 190, 20, TXT, "Cloud WAN / TGW アタッチメント")
edge([(X0 + 24, NY + 72), (X0 + 94, NY + 72)], E_VPN)
box(X0 + 104, NY + 62, 190, 20, TXT, "Site-to-Site VPN")
box(X0 + 330, NY, 780, 112, G_NOTE, "ルーティングの注記")
box(X0 + 344, NY + 26, 752, 82, TXT,
    "Core Network Policy version 2025.11 / Core Network ASN レンジ 64520-64534 / Routing Policy 適用モード off<br>"
    "Cloud WAN 直アタッチ VPC と TGW 配下 VPC のサブネットのルートテーブルは 10.0.0.0/8 宛を Cloud WAN / TGW に向けている<br>"
    "オンプレミス相当 VPC は Cloud WAN にアタッチせず Site-to-Site VPN だけで接続する。Private Subnet は 0.0.0.0/0 を VPN ルーターの eth1 に向ける<br>"
    "Routing Policy 適用時は secondary リージョンの CNE の ASN 64521 / 64523 にマッチさせて AS_PATH に 4200000001 を prepend する")
box(X0 + 1140, NY, 560, 112, G_NOTE, "監視 / スタック")
box(X0 + 1154, NY + 26, 532, 66, TXT,
    "4 リージョンすべての Transit Gateway で TGW Flow Logs を有効化し各リージョンの CloudWatch Logs へ出力<br>"
    "ap-northeast-1 の CloudWatch Dashboard で 4 リージョン分をクロスリージョン表示<br>"
    "CloudWanRoutingCoreStack / DashboardStack: ap-northeast-1、RegionStack: 各リージョン")

xml = ('<mxfile host="app.diagrams.net"><diagram name="architecture">'
       '<mxGraphModel dx="1600" dy="900" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" '
       f'fold="1" page="1" pageScale="1" pageWidth="{TOTAL_W + 120}" pageHeight="{NY + 190}" math="0" shadow="0" '
       'adaptiveColors="auto"><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
       + "".join(cells) + '</root></mxGraphModel></diagram></mxfile>')
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "architecture.drawio")
open(out, "w", encoding="utf-8").write(xml)
print("written", out, TOTAL_W + 120, "x", NY + 190)
