var rpc = require('rpc-stream');
var createClient = require('./client');
var Hooks = require('level-hooks');
var net = require('net');
var ttl = require('level-ttl');

var prefix = '!!!';
var HR1 = { ttl: 1000 * 60 * 60 };

function Server(localdb, opts) {

  var batch = localdb.batch;
  var put = localdb.put;

  opts = opts || {};
  opts.peers = opts.peers || [];
  var methods = {};

  methods.quorum = function (key, value, type, cb) {

    put.call(localdb, prefix + key, type, HR1, cb);
  };
  
  methods.commit = function (key, value, type, cb) {

    batch.call(
      localdb,
      [
        { type: 'del', key: prefix + key },
        { type: type, key: key, value: value }
      ],
      cb
    );
  }; 

  var server = rpc(methods);
  var connections = {};
  var loaded;

  server.addPeer = function(peer) {

    if (loaded && opts.peers.some(function(p) {
      var host = p.host == peer.host;
      var port = p.port == peer.port;
      return host && port;
    })) return;

    client = createClient(opts);
    client.connect(peer.port, peer.host);

    client.on('connect', function(s) {
      var r = rpc();
      remote = r.wrap(methods);
      connections[peer.port + peer.host] = r.wrap(methods);
      r.pipe(s).pipe(r);
      
      if (opts.peers.indexOf(peer) == -1) {
        opts.peers.push(peer);
      }
    });
  };

  opts.peers.forEach(server.addPeer);
  loaded = true;

  Hooks(ttl(localdb));

  function getQuorum(key, value, type, done) {

    var phase = 'quorum';
    var index = 0;

    !function connect() {
      opts.peers.map(function(peer) {

        var remote = connections[peer.port + peer.host];
       
        function write() {
          remote[phase](key, value, type, function(err) {
            if (err) {
              return done(err);
            }

            if (++index == opts.peers.length) {
              if (phase != 'quorum') {
                return done();
              }

              phase = 'commit';
              index = 0;
              connect();
            }
          });
        }

        if (remote) {
          return write();
        }

        var retrycount = 0;
        var err = new Error('Connection Fail %s:%s', peer.host, peer.port);

        var retry = setInterval(function() {
          remote = connections[peer.port + peer.host];

          if (++retrycount == opts.failAfter * 1e3) {
            clearInterval(retry);
            return done(err);
          }

          if (!remote) {
            return;
          }

          clearInterval(retry);
          write();
        }, 100);

      });
    }();
  }

  localdb.hooks.pre({ start: prefix + '~' }, function (op, done) {

    localdb.put(prefix + op.key, op.value, function (err) {
      if (err) return done(err);

      getQuorum(op.key, op.value, op.type, function(err) {
        if (err) return done(err);
        methods.commit(op.key, op.value || '', op.type, done);
      });
    });
  });

  return server;
}

exports.Server = Server;
exports.createServer = Server;

