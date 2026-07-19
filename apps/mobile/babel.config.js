module.exports = function (api) {
  api.cache(true);
  return {
    // unstable_transformImportMeta: lets ESM deps that ship `import.meta`
    // syntax bundle for Hermes (which cannot parse it natively).
    presets: [['babel-preset-expo', { unstable_transformImportMeta: true }]],
  };
};
