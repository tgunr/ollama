const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const webpack = require('webpack');

module.exports.plugins = [
  new ForkTsCheckerWebpackPlugin({
    logger: 'webpack-infrastructure',
  }),
  new webpack.DefinePlugin({
    'process.env.TELEMETRY_WRITE_KEY': JSON.stringify(process.env.TELEMETRY_WRITE_KEY),
  }),
];
