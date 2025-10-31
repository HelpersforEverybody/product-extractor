import macys from "./macys.js";

const REGISTRY = [ macys ];

export function chooseExtractor(siteId, url) {
  if (siteId && siteId !== "auto") {
    return REGISTRY.find(x => x.id === siteId) || null;
  }
  try {
    const host = new URL(url).hostname;
    return REGISTRY.find(x => x.match.hostRegex.test(host)) || null;
  } catch { return null; }
}
