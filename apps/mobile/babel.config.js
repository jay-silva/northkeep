module.exports = function (api) {
  api.cache(true);
  return {
    // unstable_transformImportMeta: unpdf (pdf.js) ships `import.meta` syntax in
    // a Node-only code path; Hermes cannot parse it without this transform.
    presets: [['babel-preset-expo', { unstable_transformImportMeta: true }]],
  };
};
