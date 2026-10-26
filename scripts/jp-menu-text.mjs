// Normalize observed menu text only, never owner instructions or approval data.
export const normalizeMenuTranscript = (text) =>
  text
    .normalize("NFKC")
    .replace(/[一二三四五六七八九〇]/g, (c) =>
      String("〇一二三四五六七八九".indexOf(c)),
    )
    // STT sometimes writes numeric ni/go as kana. Require a menu-like boundary
    // and the selection particle; do not rewrite words such as カニ or ゴール.
    .replace(
      /(^|番号|[はに、,。\s])(ニ|ゴー?)(?=(?:番)?を)/g,
      (_match, prefix, digit) => prefix + (digit === "ニ" ? "2" : "5"),
    );
