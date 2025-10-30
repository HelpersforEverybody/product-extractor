import urlLib from "url";
import macys from "./macys.js";

const REGISTRY = [ macys ];

export function chooseExtractor(siteId, url) {
  if (siteId && siteId !== "auto") {
    return REGISTRY.find(x => x.id === siteId) || null;
  }
  const host = url ? new urlLib.URL(url).hostname : "";
  return REGISTRY.find(x => x.match.hostRegex.test(host)) || null;
}
