// RINOTE Phase 1 — 照合API (Vercel Serverless Function / ES Module)
// 役割: ①ログイン確認 ②1日の回数制限 ③プロンプト組み立て ④Anthropic API呼び出し
// 必要な環境変数: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, DAILY_LIMIT(任意・既定3)

const SYS = `あなたは企業開示資料を整理するアシスタントです。
禁止：買い推奨・売り推奨・目標株価・株価予測・「〜すべき」という表現・理由の否定や採点。
文体：初心者向け、平易な日本語、です・ます調。専門用語には一言の説明を添える。`;

function checkPrompt(d) {
  return `${SYS}
銘柄「${d.name}」について最新の決算・開示情報をweb検索で確認し、ユーザーの検討内容と照合してください。
検討理由：「${d.reason}」／保有期間：「${d.period || "未定"}」／不安：「${d.anxiety || "未記入"}」

出力の構成：
- reason_type：A=抽象的（中身が特定できない）、B=具体的、C=検証不能（好き・応援など気持ちの理由）
- match_level：理由を最新の開示と照合した判定。「一致」「一部一致」「現時点の開示とは一致しない」のいずれか。reason_typeがCの場合のみ「照合対象外」とする。理由の否定や採点はせず、開示された事実と整合するかだけを判定する
- conclusion：判定の根拠を1〜2文で説明（断定しすぎない。Cの場合は理由を尊重する一言＋直近の事実1文）
- facts：理由に関係する見るべきデータを2〜3点。各点「項目名：数値や事実」の形式
- facts_basis：上の出典（例：2025年12月期 第3四半期決算）
- anxiety_answer：不安に対する事実ベースの回答1〜2文（不安が未記入なら空文字）
- anxiety_basis：その出典（不安未記入なら空文字）
- cautions：この銘柄・この理由に固有の、購入前に知っておくべき注意点を2点。汎用的な注意は禁止
- cautions_basis：その出典
- options：reason_typeがAの場合のみ、ユーザーの理由をより具体的に言い換えた候補を3つ。この銘柄の実際の事業・決算内容に即した、そのまま投資理由として使える短い一文にする（例：「クラウド事業の売上が前年比20%以上伸びているから」）。BとCは空配列
- signal_suggestions：この理由が崩れたと判断できる客観的サインを2つ。次の決算・月次で確認できる具体的なもの
- watch_points：定点観測ポイントを2〜3点。決算以外も含める（月次データ、競合の動き、業界ニュース、原材料・為替など）。各点「何を・どこで・どの頻度で見るか」が分かる一文にする

以下のJSONのみ返す（前置き・コードブロック禁止）：
{"reason_type":"A|B|C","match_level":"一致|一部一致|現時点の開示とは一致しない|照合対象外","conclusion":"...","facts":["...","..."],"facts_basis":"...","anxiety_answer":"...","anxiety_basis":"...","cautions":["...","..."],"cautions_basis":"...","options":[],"signal_suggestions":["...","..."],"watch_points":["...","..."]}`;
}

function recheckPrompt(r) {
  const isMio = r.decision === "見送り";
  return `${SYS}
銘柄「${r.name}」の最新の決算・開示情報をweb検索で確認してください。
${
  isMio
    ? `ユーザーは過去にこの銘柄を見送りました。見送り理由：「${r.reason}」。その後この企業に何が起きたか、見送り理由に関係する事実を中立に伝えてください（見送りの正誤は裁定しない）。`
    : `ユーザーの理由：「${r.reason}」／見直しサイン：「${r.signal || "未設定"}」。見直しサインが設定されている場合、そのサインに触れているかを必ず確認してください。`
}
${isMio ? "" : `match_level：理由を最新の開示と照合した判定。「一致」「一部一致」「現時点の開示とは一致しない」のいずれか（気持ちの理由など検証不能な場合は「照合対象外」）。`}
conclusion：1〜2文。facts：見るべきデータ2点。basis：出典1つ。
以下のJSONのみ返す：{${isMio ? "" : `"match_level":"...",`}"conclusion":"...","facts":["...","..."],"basis":"..."}`;
}

const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
};

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

// レスポンスからテキストブロックを抽出（ツール使用ブロックをスキップ）
function extractText(content) {
  return (content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
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
  const prompt = kind === "recheck" ? recheckPrompt(data) : checkPrompt(data);

  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 1200,
        tools: [WEB_SEARCH_TOOL],
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

    // stop_reason が "tool_use" の場合、ツール実行後のレスポンスを待つ必要があるが
    // web_search は Claude 側で自動処理されるため、最終的なテキストを取得する
    let text = extractText(out.content);

    // テキストが空でツール使用のみの場合、追加でメッセージを送信してfinal responseを得る
    if (!text && out.stop_reason === "tool_use") {
      const toolUseBlocks = (out.content || []).filter((b) => b.type === "tool_use");
      const toolResults = toolUseBlocks.map((b) => ({
        type: "tool_result",
        tool_use_id: b.id,
        content: "",
      }));

      const followRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "web-search-2025-03-05",
        },
        body: JSON.stringify({
          model: "claude-opus-4-8",
          max_tokens: 1200,
          tools: [WEB_SEARCH_TOOL],
          messages: [
            { role: "user", content: prompt },
            { role: "assistant", content: out.content },
            { role: "user", content: toolResults },
          ],
        }),
      });

      if (followRes.ok) {
        const followOut = await followRes.json();
        text = extractText(followOut.content);
      }
    }

    const m = text.replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : "{}");

    await setUsage(user.id, day, used + 1);
    return res.status(200).json({ result: parsed, remaining: limit - used - 1 });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "照合に失敗しました。再試行してください。" });
  }
}
