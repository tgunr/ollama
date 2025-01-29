const rules = require('./webpack.rules.cjs');
const plugins = require('./webpack.plugins.cjs');

module.exports = {
  /**
   * This is the main entry point for your application, it's the first file
   * that runs in the main process.
   */
  entry: './src/index.ts',
  // Put your normal webpack config below here
  module: {
    rules: rules.rules,
  },
  plugins: plugins.plugins || [],
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
    fallback: {
      path: require.resolve('path-browserify'),
      crypto: require.resolve('crypto-browserify'),
      os: require.resolve('os-browserify/browser'),
      stream: require.resolve('stream-browserify'),
      vm: require.resolve('vm-browserify'),
      fs: false,
      child_process: false
    },
  },
  devtool: 'source-map',
};
