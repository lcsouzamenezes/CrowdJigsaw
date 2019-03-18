'use strict'

var express = require('express');
var router = express.Router();
var RoundModel = require('../models/round').Round;
var ActionModel = require('../models/action').Action;
var CogModel = require('../models/cog').Cog;
var DiffModel = require('../models/diff').Diff;
var util = require('./util.js');
var constants = require('../config/constants');
var dirs = ['top', 'right', 'bottom', 'left'];
const Promise = require('bluebird');
const redis = require('redis').createClient();
var roundNodesAndHints = {};

/**
 * Calculate the contribution according to the alpha decay function
 * num_before can be sup or opp
 */
function calcContri(operation, num_before) {
    var alpha = constants.alpha;
    num_before = Number(num_before);
    let contribution = 0;
    switch (operation) {
        case "++":
            contribution = 1;
            break;
        case "+":
            contribution = Math.pow(alpha, num_before);
            break;
        case "--":
            contribution = 0.5;
            break;
        case "-":
            contribution = Math.pow(alpha, num_before * 2);
            break;
        default:
            contribution = 0;
    }
    return contribution.toFixed(3);
}

/**
 * Write one action into the action sequence
 */
function saveAction(round_id, time, player_name, links_size, logs, is_hint) {
    var action = {
        round_id: round_id,
        time: time,
        player_name: player_name,
        is_hint: is_hint,
        links_size: links_size,
        logs: logs
    }
    ActionModel.create(action, function (err) {
        if (err) {
            console.log(err);
        } 
    });
}

function initNodesAndEdges(roundID, tilesNum){
    var nodesAndHints = {};
    nodesAndHints.nodes = new Array(tilesNum);
    nodesAndHints.hints = new Array(tilesNum);

    for (var i = 0; i < tilesNum; i++) {
        nodesAndHints.nodes[i] = {
            up: {
                indexes: {},
                maxConfidence: 0,
            },
            right: {
                indexes: {},
                maxConfidence: 0,
            },
            bottom: {
                indexes: {},
                maxConfidence: 0,
            },
            left: {
                indexes: {},
                maxConfidence: 0,
            },
        };
        nodesAndHints.hints[i] = new Array(-1, -1, -1, -1);
    }
    roundNodesAndHints[roundID] = nodesAndHints;
}

function getNodesAndHints(roundID, tilesNum, edges_saved){
    let nodesAndHints = roundNodesAndHints[roundID];
    if(!nodesAndHints){
        initNodesAndEdges(roundID, tilesNum);
        nodesAndHints = roundNodesAndHints[roundID];

        for (let e in edges_saved) {
            let edge = edges_saved[e];
            updateNodesAndEdges(nodesAndHints, edge);
        }
    }
    return nodesAndHints;
}

function updateNodesLinks(nodeLink, x, y, dir, confidence, weight, edge, nowTime, hints){
    nodeLink.indexes[y] = {
        "confidence": confidence,
        "weight": weight,
        "edge": edge,
    };
}

function generateHints(roundID, nodesAndHints){
    var nodes = nodesAndHints.nodes;
    var hints = nodesAndHints.hints;

    var nowTime = (new Date()).getTime();

    var tilesNum = hints.length; 
    var dirName = ['up', 'right', 'bottom', 'left'];
    for (var x = 0; x < tilesNum; x++) {
        for(var d = 0; d < 4; d++){
            hints[x][d] = -1;
            nodes[x][dirName[d]].maxConfidence = 0;
            for(var y in nodes[x][dirName[d]].indexes){
                var confidence = nodes[x][dirName[d]].indexes[y].confidence;
                if(confidence > nodes[x][dirName[d]].maxConfidence){
                    nodes[x][dirName[d]].maxConfidence = confidence;
                    hints[x][d] = Number(y);
                }
            }
        }
    }
}

function updateNodesAndEdges(nodesAndHints, edge){
    var nodes = nodesAndHints.nodes;
    var hints = nodesAndHints.hints;

    var confidence = edge.confidence;
    var weight = edge.weight;
    var x = Number(edge.x);
    var y = Number(edge.y);
    var tag = edge.tag;
    var supporters = edge.supporters;
    if(!supporters){
        return;
    }
    var nowTime = (new Date()).getTime();
    var sLen = Object.getOwnPropertyNames(supporters).length;
    var sConfidence = confidence * sLen;
    if(tag == "T-B"){
        if(nodes[x].bottom.indexes[y]) {
            if(confidence < constants.phi || sLen < constants.msn){
                delete nodes[x].bottom.indexes[y];
                delete nodes[y].up.indexes[x];
            }
        }
        if(confidence >= constants.phi && sLen >= constants.msn){
            updateNodesLinks(nodes[x].bottom, x, y, 2, sConfidence, weight, edge, nowTime, hints);
            updateNodesLinks(nodes[y].up, y, x, 0, sConfidence, weight, edge, nowTime, hints);
        }
    }
    else if(tag == "L-R"){
        if(nodes[x].right.indexes[y]) {
            if(confidence < constants.phi || sLen < constants.msn){
                delete nodes[x].right.indexes[y];
                delete nodes[y].left.indexes[x];
            }
        }
        if(confidence >= constants.phi && sLen >= constants.msn){
            updateNodesLinks(nodes[x].right, x, y, 1, sConfidence, weight, edge, nowTime, hints);
            updateNodesLinks(nodes[y].left, y, x, 3, sConfidence, weight, edge, nowTime, hints);
        }
    }
}

function initUnsureHints(unsureHints, index){
    unsureHints[index] = {};
    unsureHints[index].index = index;
    unsureHints[index].aroundTiles = new Array([],[],[],[]);
    unsureHints[index].maxWeight = 0;
    unsureHints[index].weightSum = 0;
}

function updateUnsureHints(unsureHints, x, y, dir, weight){
    if(!unsureHints[x]){
        initUnsureHints(unsureHints, x);
    }
    var fixedWeight = Number(Number(weight).toFixed(3));
    unsureHints[x].aroundTiles[dir].push(Number(y));
    if(fixedWeight > unsureHints[x].maxWeight){
        unsureHints[x].maxWeight = fixedWeight;
    }
    unsureHints[x].weightSum += fixedWeight;
}

function sortUnsureHints(a, b){
    return a.weightSum < b.weightSum;
}

function checkUnsureHints(nodesAndHints){
    var nodes = nodesAndHints.nodes;
    var hints = nodesAndHints.hints;
    var unsureHints = [];
    var nowTime = (new Date()).getTime();
    var tilesNum = hints.length; 
    var dirName = ['up', 'right', 'bottom', 'left'];
    for (var x = 0; x < tilesNum; x++) {
        for (var d = 0; d < 4; d++){
            var unsure = false;
            if(hints[x][d] >= 0){
                for(var y in nodes[x][dirName[d]].indexes){
                    var confidence = nodes[x][dirName[d]].indexes[y].confidence;
                    if (hints[x][d] != y && confidence >= (nodes[x][dirName[d]].maxConfidence * (1-constants.epsilon))) {
                        unsure = true;
                        var weight = nodes[x][dirName[d]].indexes[y].weight;
                        updateUnsureHints(unsureHints, x, y, d, weight);
                    }
                }
                if(unsure){
                    let y = hints[x][d];
                    let weight = nodes[x][dirName[d]].indexes[y].weight;
                    updateUnsureHints(unsureHints, x, y, d, weight);
                    hints[x][d] = -1;
                }
            }
        }
    }
    unsureHints.sort(sortUnsureHints);
    nodesAndHints.unsureHints = unsureHints;
}

function generateEdgeObject(x, y, tag, supporters, opposers, confidence, weight){
    return {
        "x": x,
        "y": y,
        "tag": tag,
        "supporters": supporters,
        "opposers": opposers,
        "confidence": confidence,
        "weight": weight
    };
}

function computeScore(round_id, round_finish, x, y, tag, size, size_before, beHinted, tilesPerRow, player_name){
    if(round_finish){
        return;
    }
    var correct = false;
    if(tag == 'L-R' && x + 1 == y && y % tilesPerRow != 0){
        correct = true;
    }
    if(tag == 'T-B' && x + tilesPerRow == y){
        correct = true;
    }
    let redis_key = 'round:' + round_id + ':scoreboard';
    var score = 0;
    if(!beHinted && correct && size > 0 && size_before <= 0){
        score = constants.create_correct_link_score;
        redis.zincrby(redis_key + ':create_correct_link', 1, player_name);
    }
    if(!beHinted && correct && size < 0 && size_before >= 0){
        score = constants.remove_correct_link_score;
        redis.zincrby(redis_key + ':remove_correct_link', 1, player_name);
    }
    if(!beHinted && !correct && size > 0 && size_before <= 0){
        score = constants.create_wrong_link_score;
        redis.zincrby(redis_key + ':create_wrong_link', 1, player_name);
    }
    if(!beHinted && !correct && size < 0 && size_before >= 0){
        score = constants.remove_wrong_link_score;
        redis.zincrby(redis_key + ':remove_wrong_link', 1, player_name);
    }
    if(beHinted && !correct && size < 0 && size_before >= 0){
        score = constants.remove_hinted_wrong_link_score;
        redis.zincrby(redis_key + ':remove_hinted_wrong_link', 1, player_name);
    }
    redis.zincrby(redis_key, score, player_name);
}

var averageTime = 0.0;
var updateTimes = 0;

function distributed_update(data) {
    let redis_players_key = 'round:' + data.round_id + ':distributed:players';
    redis.sadd(redis_players_key, data.player_name, function(err) {
        if (err) {
            console.log(err);
        } else {
            let sup_key = 'round:' + data.round_id + ':distributed:sup_edges:' + data.player_name;
            let opp_key = 'round:' + data.round_id + ':distributed:opp_edges:' + data.player_name;
            for (let key in data.edges) {
                let e = data.edges[key];
                if (e.size > 0) {
                    redis.sadd(sup_key, key, function(err, count) {
                        if (count == 1 && e.beHinted && e.from != data.player_name) {
                            let redis_key = 'round:' + data.round_id + ':distributed:hint_sup';
                            redis.zincrby(redis_key, 1, e.from);
                        }
                    });
                    redis.srem(opp_key, key);
                } else {
                    redis.srem(sup_key, key, function(err, count) {
                        if (count == 1 && e.beHinted && e.from != data.player_name) {
                            let redis_key = 'round:' + data.round_id + ':distributed:hint_opp';
                            redis.zincrby(redis_key, 1, e.from);
                        }
                    });
                    redis.sadd(opp_key, key);
                }
            }
        }
    });
}

function update(data) {
    // fetch the saved edges data of this round
    let roundID = data.round_id;
    let redis_key = 'round:' + roundID;
    redis.get(redis_key, function(err, round_json) {
        if (err) {
            console.log(err);
        } else if (round_json) {
            let round = JSON.parse(round_json);
            let redis_key = 'round:' + roundID + ':edges';
            redis.get(redis_key, function (err, edges_json) {
                if (err) {
                    console.log(err);
                } else {
                    let edges_saved = {};
                    if (edges_json) {
                        edges_saved = JSON.parse(edges_json);
                    }
                    let time = (new Date()).getTime();
                    saveAction(roundID, time, data.player_name, data.edges, data.logs, data.is_hint);

                    for (let key in data.edges) {
                        let e = data.edges[key];
                        // if the edge exists, update the size
                        if (edges_saved.hasOwnProperty(key)) {
                            let supporters = edges_saved[key].supporters;
                            let opposers = edges_saved[key].opposers;
                            if (e.size > 0) {
                                if (supporters.hasOwnProperty(data.player_name)) {
                                    computeScore(roundID, (round.solved_players > 0), e.x, e.y, e.tag, e.size, supporters[data.player_name], e.beHinted, round.tilesPerRow, data.player_name);
                                    supporters[data.player_name] = e.size * (e.beHinted ? constants.decay : 1) * (e.size / e.nodes);
                                } else if (opposers.hasOwnProperty(data.player_name)) {
                                    computeScore(roundID, (round.solved_players > 0), e.x, e.y, e.tag, e.size, -opposers[data.player_name], e.beHinted, round.tilesPerRow, data.player_name);
                                    supporters[data.player_name] = e.size * (e.beHinted ? constants.decay : 1) * (e.size / e.nodes);
                                    delete opposers[data.player_name];
                                } else {
                                    computeScore(roundID, (round.solved_players > 0), e.x, e.y, e.tag, e.size, 0, e.beHinted, round.tilesPerRow, data.player_name);
                                    supporters[data.player_name] = e.size * (e.beHinted ? constants.decay : 1) * (e.size / e.nodes);
                                }
                            } else { // e.size<0(e.size==0?)
                                if (supporters.hasOwnProperty(data.player_name)) {
                                    computeScore(roundID, (round.solved_players > 0), e.x, e.y, e.tag, e.size, supporters[data.player_name], e.beHinted, round.tilesPerRow, data.player_name);
                                    opposers[data.player_name] = e.size * (e.size / e.nodes);
                                    delete supporters[data.player_name];
                                } else if (opposers.hasOwnProperty(data.player_name)) {
                                    computeScore(roundID, (round.solved_players > 0), e.x, e.y, e.tag, e.size, -opposers[data.player_name], e.beHinted, round.tilesPerRow, data.player_name);
                                    opposers[data.player_name] = e.size * (e.size / e.nodes);
                                } else {
                                    computeScore(roundID, (round.solved_players > 0), e.x, e.y, e.tag, e.size, 0, e.beHinted, round.tilesPerRow, data.player_name);
                                    opposers[data.player_name] = e.size * (e.size / e.nodes);
                                }
                            }
                        } else {
                            // if the edge not exists, create the edge
                            let supporters = {};
                            let opposers = {};
                            let weight = 0;
                            if (e.size > 0) {
                                computeScore(roundID, (round.solved_players > 0), e.x, e.y, e.tag, e.size, 0, e.beHinted, round.tilesPerRow, data.player_name);
                                supporters[data.player_name] = e.size * (e.beHinted ? constants.decay : 1) * (e.size / e.nodes);
                                weight += supporters[data.player_name];
                            } else {
                                computeScore(roundID, (round.solved_players > 0), e.x, e.y, e.tag, e.size, 0, e.beHinted, round.tilesPerRow, data.player_name);
                                opposers[data.player_name] = e.size * (e.size / e.nodes);
                            }
                            let confidence = 1;
                            edges_saved[key] = generateEdgeObject(e.x, e.y, e.tag, supporters, opposers, confidence, weight);
                        }
                    }

                    let nodesAndHints = getNodesAndHints(roundID, round.tile_num, edges_saved);

                    // update the confidence of every saved edge
                    for (let e in edges_saved) {
                        let oldConfidence = edges_saved[e].confidence;
                        let oldWeight = edges_saved[e].weight;
                        let supporters = edges_saved[e].supporters;
                        let opposers = edges_saved[e].opposers;
                        let wp = 0;
                        let wn = 0;
                        for (let s in supporters) {
                            wp += supporters[s];
                        }
                        for (let o in opposers) {
                            wn += opposers[o];
                        }
                        edges_saved[e].weight = wp;
                        if (wp + wn != 0) {
                            edges_saved[e].confidence = wp / (wp + wn);
                            if(edges_saved[e].confidence < oldConfidence){
                                updateNodesAndEdges(nodesAndHints, edges_saved[e]);
                            }
                        }
                    }

                    for (let e in edges_saved) {
                        updateNodesAndEdges(nodesAndHints, edges_saved[e]);
                    }
                    generateHints(roundID, nodesAndHints);
                    checkUnsureHints(nodesAndHints);
                    computeCog(roundID, edges_saved, time, round.tilesPerRow, round.tilesPerColumn, nodesAndHints);
                    
                    redis.set(redis_key, JSON.stringify(edges_saved));
                }
            });
        }
    });
}

function updateForGA(data) {
    // fetch the saved edges data of this round
    let roundID = data.round_id;
    let redis_key = 'round:' + roundID + ':edges:ga';
    redis.get(redis_key, function (err, doc) {
        if (err) {
            console.log(err);
        } else {
            let edges_saved = {};
            if (doc) {
                edges_saved = JSON.parse(doc);
            }
            for (let key in data.edges) {
                let e = data.edges[key];
                // if the edge exists, update the size
                if (edges_saved.hasOwnProperty(key)) {
                    let supporters = edges_saved[key].supporters;
                    let opposers = edges_saved[key].opposers;
                    if (e.size > 0) {
                        if (supporters.hasOwnProperty(data.player_name)) {
                            supporters[data.player_name] = e.size * (e.beHinted ? constants.decay : 1) * (e.size / e.nodes);
                        } else if (opposers.hasOwnProperty(data.player_name)) {
                            supporters[data.player_name] = e.size * (e.beHinted ? constants.decay : 1) * (e.size / e.nodes);
                            delete opposers[data.player_name];
                        } else {
                            supporters[data.player_name] = e.size * (e.beHinted ? constants.decay : 1) * (e.size / e.nodes);
                        }
                    } else { // e.size<0(e.size==0?)
                        if (supporters.hasOwnProperty(data.player_name)) {
                            opposers[data.player_name] = e.size * (e.size / e.nodes);
                            delete supporters[data.player_name];
                        } else if (opposers.hasOwnProperty(data.player_name)) {
                            opposers[data.player_name] = e.size * (e.size / e.nodes);
                        } else {
                            opposers[data.player_name] = e.size * (e.size / e.nodes);
                        }
                    }
                } else {
                    // if the edge not exists, create the edge
                    let supporters = {};
                    let opposers = {};
                    let weight = 0;
                    if (e.size > 0) {
                        supporters[data.player_name] = e.size * (e.beHinted ? constants.decay : 1) * (e.size / e.nodes);
                        weight += supporters[data.player_name];
                    } else {
                        opposers[data.player_name] = e.size * (e.size / e.nodes);
                    }
                    let confidence = 1;
                    edges_saved[key] = generateEdgeObject(e.x, e.y, e.tag, supporters, opposers, confidence, weight);
                }
            }
            // update the confidence of every saved edge
            for (let e in edges_saved) {
                let oldConfidence = edges_saved[e].confidence;
                let oldWeight = edges_saved[e].weight;
                let supporters = edges_saved[e].supporters;
                let opposers = edges_saved[e].opposers;
                let wp = 0;
                let wn = 0;
                for (let s in supporters) {
                    wp += supporters[s];
                }
                for (let o in opposers) {
                    wn += opposers[o];
                }
                edges_saved[e].weight = wp;
                if (wp + wn != 0) {
                    edges_saved[e].confidence = wp / (wp + wn);
                }
            }
            redis.set(redis_key, JSON.stringify(edges_saved));
        }
    });
}

function computeCog(roundID, edges_saved, time, tilesPerRow, tilesPerColumn, nodesAndHints){
    var totalLinks = 2 * tilesPerRow * tilesPerColumn - tilesPerRow -tilesPerColumn;
    var completeLinks = Object.getOwnPropertyNames(edges_saved).length;
    var correctLinks = 0;
    for (e in edges_saved) {
        edge = edges_saved[e];
        if(edge.tag == 'L-R'){
            if(edge.x + 1 == edge.y && edge.y % tilesPerRow != 0){
                correctLinks += 1;
            }
        }
        else{
            if(edge.x + tilesPerColumn == edge.y){
                correctLinks += 1;
            }
        }
    }

    var brief_edges_saved = {};
    for (var e in edges_saved) {
        var edge = edges_saved[e];
        var supporters = edge.supporters;
        var opposers = edge.opposers;
        var sLen = Object.getOwnPropertyNames(supporters).length;
        var oLen = Object.getOwnPropertyNames(opposers).length;
        var wp = edge.weight;
        var confidence = edge.confidence;
        var wn = 0;
        if(confidence > 0){
            wn = wp / confidence - wp;
        }
        else{
            for (var o in opposers) {
                wn += opposers[o];
            }
        }
        wp = Number(wp).toFixed(2);
        wn = Number(wn).toFixed(2);
        brief_edges_saved[e] = {
            wp: wp,
            wn: wn,
            sLen: sLen,
            oLen: oLen
        }
    }

    var correctHints = 0;
    for (var i = 0; i < nodesAndHints.hints.length; i++) {
        var hint = nodesAndHints.hints[i];
        if(i >= tilesPerRow && (i - tilesPerRow) == hint[0]){ //up
            correctHints += 1;
        }
        if(i % tilesPerRow < tilesPerRow - 1 && (i + 1) == hint[1]){ //right
            correctHints += 1;
        }
        if(i < (tilesPerColumn - 1) * tilesPerRow && (i + tilesPerRow) == hint[2]){ //bottom
            correctHints += 1;
        }
        if(i % tilesPerRow > 0 && (i - 1) == hint[3]){ //left
            correctHints += 1;
        }
    }

    var Cog = {
        round_id: roundID,
        time: time,
        correctLinks: correctLinks,
        correctHints: correctHints,
        completeLinks: completeLinks,
        totalLinks: totalLinks,
        ga_edges: nodesAndHints.GA_edges,
        nodes: nodesAndHints.nodes,
        hints: nodesAndHints.hints,
        edges_saved: brief_edges_saved,
    }
    CogModel.create(Cog, function (err) {
        if (err) {
            console.log(err);
            return false;
        } else {
            return true;
        }
    });
}

function computeContribution(nodesAndHints){
    var nodes = nodesAndHints.nodes;
    var hints = nodesAndHints.hints;

    var hintsCount = 0;

    var contibutionMap = {};
    for (var x = 0; x < hints.length; x++) {
        for(var d = 0; d < 4; d++){
            var direction = undefined;
            switch(d){
                case 0: direction = 'up'; break;
                case 1: direction = 'right'; break;
                case 2: direction = 'bottom'; break;
                case 3: direction = 'left'; break;
                default: break;
            }
            if(hints[x][d] >= 0 && nodes[x][direction]){
                hintsCount += 1;
                var y = hints[x][d];
                var edge = nodes[x][direction].indexes[y].edge;
                var weight = edge.weight;
                var supporters = edge.supporters;
                for (var s in supporters) {
                    var contribution = supporters[s] / weight;
                    if(!contibutionMap[s]){
                        contibutionMap[s] = 0;
                    }
                    contibutionMap[s] += contribution;
                }
            }
        }
    }

    var sum = 0;
    var latestPlayer = undefined;
    for(var p in contibutionMap){
        contibutionMap[p] /= hintsCount;
        contibutionMap[p] = Number(Number(contibutionMap[p]).toFixed(5));
        sum += contibutionMap[p];
        latestPlayer = p;
    }
    if(latestPlayer){
        contibutionMap[latestPlayer] += 1 - sum;
    }

    return contibutionMap;
}

function mergyGA(round_id, time, ga_json, nodesAndHints){
    let hints = nodesAndHints.hints;
    let hints_json = JSON.stringify(hints);
    DiffModel.create({
        round_id: round_id,
        time: time,
        ga_edges: ga_json,
        hints: hints_json
    }, function (err) {
        if (err) {
            console.log(err);
            return false;
        }
        else {
            return true;
        }
    });
    let ga_edges = JSON.parse(ga_json);
    nodesAndHints.GA_edges = ga_edges;
    let mergedHints = new Array(hints.length);
    for (var i = 0; i < hints.length; i++) {
        mergedHints[i] = [-1, -1, -1, -1];
    }
    for(let edge of ga_edges){
        let sp = edge.split('-');
        let x = parseInt(sp[0].substr(0, sp[0].length - 1));
        let y = parseInt(sp[1].substr(1));
        let tag = sp[1][0] == 'R' ? 'L-R' : 'T-B';
        if(tag == 'L-R'){
            if (hints[x][1] == y && hints[y][3] == x) {
                mergedHints[x][1] = y;
                mergedHints[y][3] = x;
            }
        }
        else {
            if (hints[x][2] == y && hints[y][0] == x) {
                mergedHints[x][2] = y;
                mergedHints[y][0] = x;
            }
        }
    }
    return mergedHints;
}

module.exports = function (io) {
    io.on('connection', function (socket) {
        socket.on('uploadForGA', function (data) {
            updateForGA(data);
        });
        socket.on('upload', function (data) {
            distributed_update(data);
            update(data);
        });

        socket.on('distributed_fetchHints', function(data) {
            let redis_players_key = 'round:' + data.round_id + ':distributed:players';
            redis.srandmember(redis_players_key, 2, function(err, players) {
                if (err) {
                    console.log(err);
                } else {
                    if (players.length == 2) {
                        Promise.join(
                            redis.zscoreAsync('round:' + data.round_id + ':distributed:hint_sup', players[0]),
                            redis.zscoreAsync('round:' + data.round_id + ':distributed:hint_opp', players[0]),
                            redis.smembersAsync('round:' + data.round_id + ':distributed:sup_edges:' + players[0]),
                            redis.zscoreAsync('round:' + data.round_id + ':distributed:hint_sup', players[1]),
                            redis.zscoreAsync('round:' + data.round_id + ':distributed:hint_opp', players[1]),
                            redis.smembersAsync('round:' + data.round_id + ':distributed:sup_edges:' + players[1])
                        ).then(function(results){
                            let playersData = new Array();
                            for (var i = 0; i < results.length; i += 3) {
                                let player = players[i/3];
                                if (player == data.player_name) {
                                    continue;
                                }
                                let sup = results[i] ? parseInt(results[i]): 0;
                                let opp = results[i+1] ? parseInt(results[i+1]): 0;
                                let edges = results[i+2] ? results[i+2]: [];
                                playersData.push({
                                    from: player, 
                                    sup: sup,
                                    opp: opp,
                                    edges: edges
                                });
                            }
                            socket.emit('distributed_proactiveHints', {
                                players: playersData,
                            });
                        });
                    }
                }
            });
        });

        // request global hints
        socket.on('fetchHints', function (data) {
            var hints = [];
            var unsureHints = {};
            var roundID = data.round_id;
            var tilesNum = data.tilesNum;
            var nodesAndHints = getNodesAndHints(roundID, tilesNum, {});
            if(nodesAndHints){
                hints = nodesAndHints.hints;
                unsureHints = nodesAndHints.unsureHints;
                let redis_key = 'round:' + roundID + ':GA_edges';
                redis.get(redis_key, function(err, doc){
                    if(doc){
                        hints = mergyGA(roundID, Date.now(), doc, nodesAndHints)
                    }
                    socket.emit('proactiveHints', {
                        sureHints: hints,
                        unsureHints: unsureHints
                    });
                });
            }
        });

        socket.on('distributed_getHintsAround', function(data) {
            let redis_players_key = 'round:' + data.round_id + ':distributed:players';
            redis.srandmember(redis_players_key, 2, function(err, players) {
                if (err) {
                    console.log(err);
                } else {
                    if (players.length == 2) {
                        Promise.join(
                            redis.zscoreAsync('round:' + data.round_id + ':distributed:hint_sup', players[0]),
                            redis.zscoreAsync('round:' + data.round_id + ':distributed:hint_opp', players[0]),
                            redis.smembersAsync('round:' + data.round_id + ':distributed:sup_edges:' + players[0]),
                            redis.zscoreAsync('round:' + data.round_id + ':distributed:hint_sup', players[1]),
                            redis.zscoreAsync('round:' + data.round_id + ':distributed:hint_opp', players[1]),
                            redis.smembersAsync('round:' + data.round_id + ':distributed:sup_edges:' + players[1])
                        ).then(function(results){
                            let playersData = new Array();
                            for (var i = 0; i < results.length; i += 3) {
                                let player = players[i/3];
                                if (player == data.player_name) {
                                    continue;
                                }
                                let sup = results[i] ? parseInt(results[i]): 0;
                                let opp = results[i+1] ? parseInt(results[i+1]): 0;
                                let edges = results[i+2] ? results[i+2]: [];
                                playersData.push({
                                    from: player, 
                                    sup: sup,
                                    opp: opp,
                                    edges: edges
                                });
                            }
                            socket.emit('distributed_reactiveHints', {
                                players: playersData,
                                indexes: data.indexes,
                                selectedTileIndexes: data.selectedTileIndexes,
                                currentStep: data.currentStep
                            });
                        });
                    }
                }
            });
        });

        // request localhints(around the selected tile)
        socket.on('getHintsAround', function (data) {
            var hints = [];
            var unsureHints = {};
            var roundID = data.round_id;
            var tilesNum = data.tilesNum;
            var nodesAndHints = getNodesAndHints(roundID, tilesNum, {});
            if(nodesAndHints){
                hints = nodesAndHints.hints;
                unsureHints = nodesAndHints.unsureHints;
                let redis_key = 'round:' + roundID + ':GA_edges';
                redis.get(redis_key, function(err, doc){
                    if(doc){
                        hints = mergyGA(roundID, Date.now(), doc, nodesAndHints)
                    }
                    socket.emit('reactiveHints', {
                        indexes: data.indexes,
                        selectedTileIndexes: data.selectedTileIndexes,
                        currentStep: data.currentStep,
                        sureHints: hints,
                        unsureHints: unsureHints
                    });
                });
            }
        });
    });

    function LoginFirst(req, res, next) {
        if (!req.session.user) {
            req.session.error = 'Please Login First!';
            return res.redirect('/login');
            //return res.redirect('back');
        }
        next();
    }

    /**
     * Access Control
     * @param {*} req 
     * @param {*} res 
     * @param {*} next 
     */
    function JoinRoundFirst(req, res, next) {

        RoundModel.findOne({ round_id: req.params.round_id }, { _id: 0, players: 1 }, function (err, doc) {
            if (err) {
                console.log(err);
            } else {
                if (doc) {
                    let hasJoined = doc.players.some(function (p) {
                        return (p.player_name == req.session.user.username);
                    });
                    if (!hasJoined) {
                        req.session.error = "You haven't joined this Round!";
                        return res.redirect('/home');
                    }
                    next();
                } else {
                    return res.redirect('/home');
                }
            }
        });
    }
    return router;
}