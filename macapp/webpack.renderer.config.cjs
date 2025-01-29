const rules = require('./webpack.rules.cjs');
const plugins = require('./webpack.plugins.cjs');

rules.rules.push({
  test: /\.css$/,
  use: [{ loader: 'style-loader' }, { loader: 'css-loader' }, { loader: 'postcss-loader' }],
});

module.exports = {
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
