'use strict';

var Utils = require('./utils.js').Utils;
var fs = require('fs');
var Redis = require("ioredis");

var plugin_name, topic_type, topic_prefix, Characteristic;
var addAccessory, addService, removeAccessory, removeService, setValue, getAccessories, getCharacteristic, updateReachability, setAccessoryInformation;
var set_timeout, client, clientSub, getterDevices;

module.exports = {
  Model: Model
}

function Model(params) {

  this.config = params.config;
  this.log = params.log;
  plugin_name = params.plugin_name;
  Characteristic = params.Characteristic;
  
  addAccessory = params.addAccessory;
  addService = params.addService;
  removeAccessory = params.removeAccessory;
  removeService = params.removeService;
  setValue = params.setValue;
  getAccessories = params.getAccessories;
  getCharacteristic = params.getCharacteristic;
  updateReachability = params.updateReachability;
  setAccessoryInformation = params.setAccessoryInformation;
}

Model.prototype.start = function() {
  return new Promise((resolve) => {
    // experimental
    if (this.config.getterDevices !== '*') {
      getterDevices = (this.config.getterDevices || '')
        .split('|')
        .reduce((sum, e) => {
          const [name, serviceName] = e.trim().split(',')
          sum.add(`${name}.${serviceName || name}`)
          return sum
        }, new Set())
    }
    topic_type = this.config.topic_type || "multiple";
    topic_prefix = this.config.topic_prefix || "homebridge";
    // todo client.end();
    // note: the plugig doesn't get the signal, because homebridge/lib/cli.js catchs the signal first.
    /*
      var signals = { 'SIGINT': 2, 'SIGTERM': 15 };
      Object.keys(signals).forEach(function (signal) {
        process.on(signal, function () {
          this.log("Got %s, closing redis-client...", signal);
          client.end();
        }.bind(this));
      }.bind(this));
    */
    this.log("Connecting..");
    const [redisURI, redisOpts = '{}'] = this.config.redis.split('?opts=')
    const opts = JSON.parse(redisOpts)
    client = new Redis(redisURI, opts)
      .on('connect', () => {
        clientSub = new Redis(this.config.redis)
          .on('connect', async function () {
            this.log("connected (url = %s)", this.config.redis);
            
            var topic = topic_prefix + '/to/*';
            clientSub.psubscribe(topic);
            this.log.debug("on.connect subscribe %s", topic);

            var plugin_version = Utils.readPluginVersion();
            var msg = plugin_name + " v" + plugin_version + " started";
            this.log.debug("on.connect %s", msg);
            
            await client.publish(topic_prefix + '/from/connected', msg);

            resolve()
          }.bind(this))
          .on('pmessage', async function (_, topic, payload) {
            if (typeof topic === "undefined" || payload.length === 0) {
              message = "topic or payload invalid";
              this.log.debug("on.message %s", message);
              await this.sendAck(false, message, 0);
              return
            }
            //this.log.debug("on.message topic %s payload %s", topic, payload);
            try {
              let accessories = JSON.parse(payload);
              if (!Array.isArray(accessories)) {
                accessories = [accessories]
              }
              await Promise.all(accessories.map(async accessory => {
                if (typeof accessory.request_id === "undefined") {
                  //this.log("added request_id=0");
                  accessory.request_id = 0;
                } else {
                    //this.log("request_id %s", accessory.request_id);
                }
                let message, result, isValid
                if (typeof accessory.subtype !== "undefined") {
                  message = "Please replace 'subtype' by 'service_name'";
                  this.log.debug("on.message %s", message);
                  await this.sendAck(false, message, accessory.request_id);
                  isValid = false;
                } else {
                  isValid = true;
                }
                if (isValid) {
                  switch (topic) {
                    case topic_prefix + "/to/add":
                    case topic_prefix + "/to/add/accessory":
                      this.log.debug("on.message add \n%s", JSON.stringify(accessory, null, 2));
                      result = await addAccessory(accessory);
                      accessory.wait_response && await this.handle(result, accessory.name, accessory.request_id);
                      break;
      
                    case topic_prefix + "/to/add/service":
                    case topic_prefix + "/to/add/services":
                      this.log.debug("on.message add/service \n%s", JSON.stringify(accessory, null, 2));
                      result = await addService(accessory);
                      accessory.wait_response && await this.handle(result, accessory.name, accessory.request_id);
                      break;
      
                    case topic_prefix + "/to/set/reachability":
                    case topic_prefix + "/to/set/reachable":
                      if (typeof accessory.reachable === "boolean") {
                        result = await updateReachability(accessory);
                        accessory.wait_response && await this.handle(result, accessory.name, accessory.request_id);
                      } else {
                        message = "accessory '" + accessory.name + "' reachable not boolean.";
                        this.log.warn("on.message %s", message);
                        await this.sendAck(false, message, accessory.request_id);
                      }
                      break;
                      
                    case topic_prefix + "/to/set/accessoryinformation":
                    case topic_prefix + "/to/set/information":
                      result = await setAccessoryInformation(accessory);
                      accessory.wait_response && await this.handle(result, accessory.name, accessory.request_id);
                      break;
                      
                    case topic_prefix + "/to/remove":
                    case topic_prefix + "/to/remove/accessory":
                      result = await removeAccessory(accessory.name);
                      accessory.wait_response && await this.handle(result, accessory.name, accessory.request_id);
                      break;
                      
                    case topic_prefix + "/to/remove/service":
                      result = await removeService(accessory);
                      accessory.wait_response && await this.handle(result, accessory.name, accessory.request_id);
                      break;
                      
                    case topic_prefix + "/to/set":
                      result = await setValue(accessory);
                      if (accessory.wait_response) {
                        if (!result.ack) {
                          await this.handle(result, accessory.name, accessory.request_id);
                        }
                      }
                      break;
      
                    case topic_prefix + "/to/get":
                      result = await getAccessories(accessory);
                      if (accessory.wait_response) {
                        if (result.ack) {
                          await this.sendAccessories(result.accessories, accessory.name, accessory.request_id);
                        } else {
                          accessory.wait_response && await this.handle(result, accessory.name, accessory.request_id);
                        }
                      }
                      break;
      
                    case topic_prefix + "/to/get/characteristic":
                      // this.log("/to/get/characteristic: %s", JSON.stringify(accessory));
                      result = await getCharacteristic(accessory);
                      if (accessory.wait_response) {
                        if (result.ack) {
                          await this.sendCharacteristic(result.characteristic, accessory.name, accessory.request_id);
                        } else {
                          await this.handle(result, accessory.name, accessory.request_id);
                        }
                      }
                      break;
      
                    default:
                      message = "topic '" + topic + "' unknown.";
                      this.log.warn("on.message default %s", message);
                      await this.sendAck(false, message, accessory.request_id);
                  }
                }
              }))
            } catch(e) {
              message = "invalid JSON format";
              this.log.debug("on.message %s (%s)", message, e.message);
              await this.sendAck(false, message, 0);
              isValid = false;
            }
          }.bind(this))
          .on('close', function () {
            this.log.warn("on.close <to analyze>");
          // todo
          //this.log("redis-client closed, shutting down Homebridge...");
          //process.exit();
          }.bind(this))
          .on('error', function (error) {
            this.log.error("on.error %s", error);
          }.bind(this))
          .on('reconnect', function () {
            this.log.warn("on.reconnect <to analyze>");
          }.bind(this))
          .on('offline', function () {
            this.log.warn("on.offline <to analyze>");
          }.bind(this))
      })
      .on('close', function () {
        this.log.warn("on.close <to analyze>");
        // todo
        //this.log("redis-client closed, shutting down Homebridge...");
        //process.exit();
      }.bind(this))
      .on('error', function (error) {
        this.log.error("on.error %s", error);
      }.bind(this))
      .on('reconnect', function () {
        this.log.warn("on.reconnect <to analyze>");
      }.bind(this))
      .on('offline', function () {
        this.log.warn("on.offline <to analyze>");
      }.bind(this))
  })
}

Model.prototype.add = async function (name, service_name) {
  const id = `device/${name}.${service_name || name}`
  const data = {
    id,
    latest_updated: Date.now()
  }
  this.log.debug('[REDIS] add "%s": %j',id, data)
  return await client.hset(id, data)
}

Model.prototype.updateReachability = async function (name, reachable) {
  const id = `device/${name}.${name}`
  const data = {
    id,
    reachable,
  }
  this.log.debug('[REDIS] updateReachability "%s": %j',id, data)
  return await client.hset(id, data)
}

Model.prototype.save = async function (msg) {
  const id = `device/${msg.name}.${msg.service_name || msg.name}`
  const data = {
    [msg.characteristic]: msg.value,
    latest_updated: Date.now()
  }
  this.log.debug('[REDIS] save "%s": %j',id, data)
  return await client.multi()
    .hset(id, data)
    .publish('device/updated', JSON.stringify(msg))
    .exec()
}

Model.prototype.remove = async function (name, service_name) {
  const isRemoveAll = !service_name || name === service_name
  if (isRemoveAll) {
    const keys = await client.keys(`device/${name}.*`)
    if (!keys.length) {
      return
    }
    const id = keys.join(',')
    this.log.debug('[REDIS] remove "%s"', id)
    await client.del(...keys)
  } else {
    const id = `device/${name}.${service_name || name}`
    this.log.debug('[REDIS] remove "%s"', id)
    await client.del(id)
  }
}

Model.prototype.get = async function (name, service_name, service_type, c, value, callback) {
  if (getterDevices && !getterDevices.has(`${name}.${service_name || name}`)) {
    return
  }
  //this.log.debug("get '%s' '%s' '%s' '%s'", name, service_name, c, value);
  var msg = {"name": name, "service_name": service_name, "service_type": service_type, "characteristic": c, "cachedValue": value};
  var topic = this.buildTopic('/from/get', name);
  await client.publish(topic, JSON.stringify(msg));
  // callback(null, null);  // not used
}

Model.prototype.set = async function (name, service_name, service_type, c, value, callback) {
  var msg = {"name": name, "service_name": service_name, "service_type": service_type, "characteristic": c, "value": value};
  var topic = this.buildTopic('/from/set', name);
  await Promise.all([
    this.save(msg),
    client.publish(topic, JSON.stringify(msg)),
  ])
  return callback()
  //this.log.debug("set '%s' '%s' '%s' %s", name, service_name, c, value);
}

Model.prototype.identify = async function (name, manufacturer, model, serialnumber, firmwarerevision) {

  var msg = {"name": name, "manufacturer": manufacturer, "model": model, "serialnumber": serialnumber, "firmwarerevision": firmwarerevision};
  //this.log.debug("identify %s", JSON.stringify(msg));
  var topic = this.buildTopic('/from/identify', name);
  await client.publish(topic, JSON.stringify(msg));
}

Model.prototype.sendAccessories = async function (accessories, name, request_id) {

  var msg = accessories;
  msg.request_id = request_id;
  this.log.debug("sendAccessories \n%s", JSON.stringify(msg, null, 2));
  var topic = this.buildTopic('/from/response', name);
  await client.publish(topic, JSON.stringify(msg));
}

Model.prototype.sendCharacteristic = async function (characteristic, name, request_id) {

  var msg = characteristic;
  msg.request_id = request_id;
  this.log.debug("sendCharacteristic \n%s", JSON.stringify(msg, null, 2));
  var topic = this.buildTopic('/from/response', name);
  await client.publish(topic, JSON.stringify(msg));
}

Model.prototype.handle = async function (result, name, request_id) {
  await this.sendAck(result.ack, result.message, request_id, name);
  this.log.debug("%s %s, %s [%s]", result.topic, result.ack, result.message, request_id);
}

Model.prototype.sendAck = async function (ack, message, request_id, name) {

  var msg = {"ack": ack, "message": message, "request_id": request_id};
  //this.log.debug("sendAck %s", JSON.stringify(msg));
  var topic = this.buildTopic('/from/response', name);
  await client.publish(topic, JSON.stringify(msg));
}

Model.prototype.buildTopic = function(topic_section, name) {
  var topic;
  if (topic_type == "single") {
    topic = topic_prefix + topic_section + '/' + name;
  } else {
    topic = topic_prefix + topic_section;
  }
  this.log.debug("buildTopic %s", topic);
  return (topic);
}
