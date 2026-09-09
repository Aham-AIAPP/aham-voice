"""按音素编辑距离纠正转写里的专名。

为什么不靠 ASR 热词偏置：实测在 seaco 上，英文缩写的显示形式（"MOM"）作热词
是零效果——四种写法的输出逐字节相同。原因是喂进去的是显示形式，而模型听到的
是口语形式；AWS Transcribe 要求缩写逐字母加句点，Azure 直接把 phonetic form
和 displayed form 分成两个字段，都是同一件事。中文口语形式（"麦斯"）能激活
偏置，但强度不足以翻转已经确定的解码结果。

所以按行业主流做法把这件事放到后处理：把候选片段和目标词都转成音素序列比
距离。中文用拼音音节，拉丁词用字母。好处是不必枚举错法——一条「MOM 读作
毛姆」就同时覆盖 冒目 / 冒陌 / 冒某 / POM。

在一段 42 分钟真实会议上实测：20 处替换里 19 处正确。唯一的误伤是
「由你们」→「优尼昂」，两者读音几乎相同，属于方法的固有极限。

思路参考 HaujetZhao/asr-hotword（音素编辑距离 + 防误杀护栏）。
"""
import re
from pypinyin import lazy_pinyin

CJK = re.compile(r"[一-龥]")
LATIN_RUN = re.compile(r"[A-Za-z]{2,8}")

# 相似音：中文里常见的混淆对，距离折半计
FUZZY = [("zh","z"),("ch","c"),("sh","s"),("an","ang"),("en","eng"),("in","ing"),("l","n"),("f","h")]

def syllables(text: str) -> list[str]:
    """混合文本 → 音节序列。中文取拼音，拉丁字母逐个拆。"""
    out = []
    for ch in text:
        if CJK.match(ch):
            out.extend(lazy_pinyin(ch))
        elif ch.isalpha():
            out.append(ch.lower())
    return out

def syl_dist(a: str, b: str) -> float:
    """两个音节的距离：相同 0，相似音 0.4，否则 1。"""
    if a == b: return 0.0
    for x, y in FUZZY:
        if (a.replace(x, y) == b.replace(x, y)) or (a.replace(y, x) == b.replace(y, x)):
            return 0.4
    # 首字母相同给一点折扣（mao vs mou）
    if a[0] == b[0]:
        common = sum(1 for i in range(min(len(a), len(b))) if a[i] == b[i])
        return max(0.35, 1.0 - common / max(len(a), len(b)))
    return 1.0

def seq_similarity(x: list[str], y: list[str]) -> float:
    """带替换代价的编辑距离，归一化成 0~1 相似度。"""
    if not x or not y: return 0.0
    n, m = len(x), len(y)
    prev = list(range(m + 1))
    for i in range(1, n + 1):
        cur = [i] + [0] * m
        for j in range(1, m + 1):
            cur[j] = min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + syl_dist(x[i-1], y[j-1]))
        prev = cur
    return 1.0 - prev[m] / max(n, m)

def correct(text: str, entries: list[dict], threshold: float = 0.65):
    """entries: [{'display':'MOM','spoken':['毛姆','mom']}]。返回 (新文本, 替换记录)。

    候选生成有意收紧，靠规则而不是靠阈值挡误伤：
      · 中文候选只取与目标音节数相同的片段（「由你」2 音节不会去撞 3 音节的
        「优尼昂」，「包主」也不会把「包主管」切一半）
      · 拉丁候选只取完整词，不取子串（否则 message 里的 age 会被当成 AGV）
      · 已经正确的位置先锁定，避免把「优尼昂」里的「优尼」再替换一次
      · 片段本身是常用词就跳过——识别多半没错，是我们在硬改
    """
    import jieba; jieba.initialize()
    targets = []
    for e in entries:
        for sp in e.get("spoken") or [e["display"]]:
            targets.append((e["display"], sp, syllables(sp)))

    used = []
    # 先锁定已经写对的地方
    for e in entries:
        for m in re.finditer(re.escape(e["display"]), text, re.I):
            used.append((m.start(), m.end()))

    cands = []
    for m in re.finditer(r"[A-Za-z]+", text):          # 完整拉丁词
        cands.append((m.start(), m.group()))
    lens = {len(t[2]) for t in targets}
    for m in re.finditer(r"[一-龥]+", text):            # 定长中文片段
        block, base = m.group(), m.start()
        for L in lens:
            for i in range(len(block) - L + 1):
                cands.append((base + i, block[i:i+L]))

    hits = []
    scored = []
    for pos, span in cands:
        syl = syllables(span)
        if not syl: continue
        for display, spoken, tsyl in targets:
            if span.lower() == display.lower(): continue
            if len(syl) != len(tsyl): continue          # 音节数必须相同
            score = seq_similarity(syl, tsyl)
            if score >= threshold:
                scored.append((score, len(span), pos, span, display, spoken))
    # 分词边界：候选必须从一个词开始、到一个词结束。「最近的系统」里的「近的」
    # 跨在「最近」中间，读音再像也不能动它——这是两字中文目标最主要的误伤来源。
    bounds = set()
    cursor = 0
    for token in jieba.cut(text, HMM=False):
        bounds.add(cursor)
        cursor += len(token)
    bounds.add(cursor)

    for score, _, pos, span, display, spoken in sorted(scored, key=lambda x: (-x[0], -x[1], x[2])):
        if any(pos < e and pos + len(span) > s for s, e in used): continue
        if CJK.match(span[0]) and not (pos in bounds and pos + len(span) in bounds): continue
        freq = jieba.get_FREQ(span)
        if freq and freq >= 200: continue
        hits.append({"pos": pos, "from": span, "to": display, "via": spoken, "score": round(score, 3)})
        used.append((pos, pos + len(span)))
    for h in sorted(hits, key=lambda x: -x["pos"]):
        text = text[:h["pos"]] + h["to"] + text[h["pos"] + len(h["from"]):]
    return text, hits
