module.exports = (path, options) => {
  // Let Jest handle the default resolution first
  return options.defaultResolver(path, {
    ...options,
    // Tell Jest to look for both commonjs and module package.json entries
    packageFilter: (pkg) => {
      // Handle packages that use "exports" field
      if (pkg.name === 'peerbit' || pkg.name === 'multiformats') {
        return {
          ...pkg,
          main: pkg.exports?.['.']?.import || pkg.exports?.['.'] || pkg.main,
        };
      }
      return pkg;
    },
  });
};