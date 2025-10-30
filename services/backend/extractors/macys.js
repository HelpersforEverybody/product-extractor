// macys extractor placeholder — implement real logic later
module.exports = {
  id: 'macys',
  match: { hostRegex: /macys\.com$/ },
  extract: async ({ page, html, url }) => {
    return {
      siteId: 'macys',
      rawTables: [],
      meta: {}
    };
  }
};
