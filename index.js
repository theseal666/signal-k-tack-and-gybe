module.exports = function (app) {
  const plugin = {};

  plugin.id = 'signal-k-tack-and-gybe';
  plugin.name = 'Tack and Gybe Performance Analyzer';
  plugin.description = 'Analyzes tacks and gybes using high-frequency H5000 data.';

  plugin.start = function (options, restartPlugin) {
    app.debug('Plugin started');
  };

  plugin.stop = function () {
    app.debug('Plugin stopped');
  };

  plugin.schema = {
    type: 'object',
    properties: {}
  };

  return plugin;
};