// Narrow listening-signal recognition, not authorization or task completion.
export const isBackchannel = (text) =>
  /^(?:(?:はい|ええ|うん|そうですね|なるほど)[。、,!！\s]*){1,3}$/.test(
    String(text ?? "")
      .normalize("NFKC")
      .trim(),
  );
