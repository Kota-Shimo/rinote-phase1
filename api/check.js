// RINOTE Phase 1 — 照合API (Vercel Serverless Function / ES Module)
// 役割: ①ログイン確認 ②1日の回数制限 ③Brave検索でコンテキスト取得 ④Haiku で解析
// 必要な環境変数: ANTHROPIC_API_KEY, BRAVE_API_KEY,
//               SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, DAILY_LIMIT(任意・既定3)
// コスト目安: Brave 無料枠(2000回/月) + Haiku ≈ $0.003〜0.005/回

const SYS = `あなたは企業開示資料を整理するアシスタントです。
禁止：買い推奨・売り推奨・目標株価・株価予測・「〜すべき」という表現・理由の否定や採点。
文体：初心者向け、平易な日本語、です・ます調。専門用語には一言の説明を添える。`;

function periodGuide(period) {
  if (period === "1年未満") {
    return "保有期間が短期（1年未満）のため、直近四半期決算・月次データ・進捗率など短期で変化が見える指標を中心に照合し、watch_pointsも月次・四半期で確認できるものにしてください。";
  }
  if (period === "1〜5年") {
    return "保有期間が中期（1〜5年）のため、通期業績の推移・中期経営計画の進捗・事業セグメントの成長性を中心に照合してください。";
  }
  if (period === "5年以上") {
    return "保有期間が長期（5年以上）のため、四半期の細かい増減より事業の競争優位・市場構造の変化・財務健全性・長期トレンドを中心に照合し、watch_pointsは半期〜年次の大きな変化を中心にしてください。";
  }
  return "";
}

function checkPrompt(d, ctx) {
  const pg = periodGuide(d.period);
  return `${SYS}

【検索で取得した最新情報】
${ctx || "（検索結果なし）"}

上記の情報を踏まえ、銘柄「${d.name}」についてユーザーの検討内容と照合してください。
検討理由：「${d.reason}」／保有期間：「${d.period || "未定"}」／不安：「${d.anxiety || "未記入"}」
${pg ? pg + "\n" : ""}
出力の構成：
- reason_type：A=抽象的（中身が特定できない）、B=具体的、C=検証不能（好き・応援など気持ちの理由）
- match_level：理由を最新の開示と照合した判定。「一致」「一部一致」「現時点の開示とは一致しない」のいずれか。reason_typeがCの場合のみ「照合対象外」とする。理由の否定や採点はせず、開示された事実と整合するかだけを判定する
- summary：「つまりどういうこと？」に答える、投資初心者向けの一言まとめ。専門用語を使わず、(1)いまの状態 (2)次に何を確認すればいいか、を2文以内で。例：「あなたの理由は直近の決算の内容と合っています。次の決算で売上が伸び続けているかだけ確認すれば大丈夫です。」
- conclusion：判定の根拠を1〜2文で説明（断定しすぎない。Cの場合は理由を尊重する一言＋直近の事実1文）
- facts：理由に関係する見るべきデータを2〜3点。各点「項目名：数値や事実（→ それが理由にとってプラスかマイナスか中立かの一言）」の形式。例：「営業利益：前年比+15%（→ 理由を支える材料です）」
- facts_basis：上の出典（例：2025年12月期 第3四半期決算）
- anxiety_answer：不安に対する事実ベースの回答1〜2文（不安が未記入なら空文字）
- anxiety_basis：その出典（不安未記入なら空文字）
- cautions：この銘柄・この理由に固有の、購入前に知っておくべき注意点を2点。汎用的な注意は禁止
- cautions_basis：その出典
- options：reason_typeがAの場合のみ、ユーザーの理由をより具体的に言い換えた候補を3つ。この銘柄の実際の事業・決算内容に即した、そのまま投資理由として使える短い一文にする（例：「クラウド事業の売上が前年比20%以上伸びているから」）。BとCは空配列
- signal_suggestions：この理由が崩れたと判断できる客観的サインを2つ。次の決算・月次で確認できる具体的なもの
- watch_points：定点観測ポイントを2〜3点。決算以外も含める（月次データ、競合の動き、業界ニュース、原材料・為替など）。各点を「何を見る｜どこで・頻度｜どうなったら注意」の3パートに分け「｜」で区切った一文にする。例：「月次売上｜会社の月次IR・毎月｜2か月連続で前年割れしたら注意」

以下のJSONのみ返す（前置き・コードブロック禁止）：
{"reason_type":"A|B|C","match_level":"一致|一部一致|現時点の開示とは一致しない|照合対象外","summary":"...","conclusion":"...","facts":["...","..."],"facts_basis":"...","anxiety_answer":"...","anxiety_basis":"...","cautions":["...","..."],"cautions_basis":"...","options":[],"signal_suggestions":["...","..."],"watch_points":["...","..."]}`;
}

function recheckPrompt(r, ctx) {
  const isMio = r.decision === "見送り";
  return `${SYS}

【検索で取得した最新情報】
${ctx || "（検索結果なし）"}

上記の情報を踏まえ、銘柄「${r.name}」について以下の内容で照合してください。
${
  isMio
    ? `ユーザーは過去にこの銘柄を見送りました。見送り理由：「${r.reason}」。その後この企業に何が起きたか、見送り理由に関係する事実を中立に伝えてください（見送りの正誤は裁定しない）。`
    : `ユーザーの理由：「${r.reason}」／保有期間：「${r.period || "未定"}」／見直しサイン：「${r.signal || "未設定"}」。見直しサインが設定されている場合、そのサインに触れているかを必ず確認してください。${periodGuide(r.period)}`
}
${isMio ? "" : `match_level：理由を最新の開示と照合した判定。「一致」「一部一致」「現時点の開示とは一致しない」のいずれか（気持ちの理由など検証不能な場合は「照合対象外」）。`}
summary：「つまりどういうこと？」に答える初心者向けの一言まとめ。専門用語なしで(1)いまの状態(2)次に確認することを2文以内で。
conclusion：1〜2文。facts：見るべきデータ2点（各点に、それが理由にとってプラスかマイナスかの一言を添える）。basis：出典1つ。
以下のJSONのみ返す：{${isMio ? "" : `"match_level":"...",`}"summary":"...","conclusion":"...","facts":["...","..."],"basis":"..."}`;
}

// Brave Search で銘柄の最新情報を取得（無料枠2000回/月）
async function braveSearch(queries) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return "";
  const results = [];
  for (const q of queries) {
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=4&search_lang=ja&country=JP&freshness=pm`;
      const res = await fetch(url, {
        headers: { "X-Subscription-Token": key, Accept: "application/json" },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const hits = (data.web?.results || []).slice(0, 4);
      for (const h of hits) {
        results.push(`■ ${h.title}\n${h.description || ""}\n出典: ${h.url}`);
      }
    } catch (_) {}
  }
  return results.join("\n\n");
}

async function getUser(req) {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  return await res.json();
}

async function getUsage(userId, day) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/rl_usage?user_id=eq.${userId}&day=eq.${day}&select=count`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) return 0;
  const rows = await res.json();
  return rows.length ? rows[0].count : 0;
}

async function setUsage(userId, day, count) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/rl_usage`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify([{ user_id: userId, day, count }]),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTのみ受け付けます" });
  }

  const user = await getUser(req);
  if (!user || !user.id) {
    return res.status(401).json({ error: "ログインが必要です" });
  }

  const limit = parseInt(process.env.DAILY_LIMIT || "3", 10);
  const day = new Date().toISOString().slice(0, 10);
  const used = await getUsage(user.id, day);
  if (used >= limit) {
    return res
      .status(429)
      .json({ error: `本日の照合回数（${limit}回）の上限に達しました。明日また確認できます。` });
  }

  const { kind, data } = req.body || {};
  if (!kind || !data || !data.name) {
    return res.status(400).json({ error: "リクエスト内容が不正です" });
  }

  try {
    // Brave で検索（2クエリ: 基本情報 + 理由に特化した検索）
    const q1 = `${data.name} 最新決算 業績`;
    const q2 = data.reason && data.reason.length > 5
      ? `${data.name} ${data.reason.slice(0, 30)}`
      : null;
    const ctx = await braveSearch(q2 ? [q1, q2] : [q1]);

    const prompt = kind === "recheck" ? recheckPrompt(data, ctx) : checkPrompt(data, ctx);

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1100,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!aiRes.ok) {
      const t = await aiRes.text();
      console.error("anthropic error", aiRes.status, t.slice(0, 500));
      const status = aiRes.status;
      if (status === 529 || status === 503) {
        return res.status(502).json({ error: "照合サービスが混み合っています。少し時間をおいてください。" });
      }
      if (status === 429) {
        return res.status(429).json({ error: "リクエストが集中しています。しばらくしてから再試行してください。" });
      }
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: "照合サービスの設定に問題があります。管理者にお問い合わせください。" });
      }
      return res.status(502).json({ error: "照合サービスでエラーが発生しました。しばらくしてから再試行してください。" });
    }

    const out = await aiRes.json();
    const text = (out.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const m = text.replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : "{}");

    await setUsage(user.id, day, used + 1);
    return res.status(200).json({ result: parsed, remaining: limit - used - 1 });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "照合に失敗しました。再試行してください。" });
  }
}
