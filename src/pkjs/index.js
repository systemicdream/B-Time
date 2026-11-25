console.log("B-Time loaded");

var API_BASE = "https://planmyride.blinetransit.com";
var MAX_CARDS = 20;          // must match MAX_CARDS in main.c
var MAX_SCHEDULE_ITEMS = 25; // must match MAX_SCHEDULE_ITEMS in main.c

// AppMessage keys, declared in "messageKeys" in package.json. Use the names, not the
// numeric IDs: the iOS app only labels incoming payloads by name.
// watch -> phone
var KEY_REQUEST_NEARBY = "REQUEST_NEARBY";
var KEY_REQUEST_SCHEDULE = "REQUEST_SCHEDULE";
// phone -> watch
var KEY_CARDS = "CARDS";
var KEY_SCHEDULE = "SCHEDULE";
var KEY_STATUS = "STATUS";
// Route number: sent with a schedule request and echoed back with the schedule
var KEY_ROUTE = "ROUTE";

Pebble.addEventListener("ready", function() {
    console.log("Ready");
});

// Persist across appmessage: routeNumber -> array of stopCodes from last GetNearbyRoutes (IN and OUT)
var lastRouteStopCodes = {};
// routeNumber -> [{ label, stopTime }] from the last GetNextStopTimes, the schedule view's fallback
var lastRouteNextTimes = {};

// --- Messaging ---

// Only one AppMessage can be in flight at a time, so queue them and retry failures
var sendQueue = [];
var sending = false;

function pumpSendQueue() {
    if (sending || sendQueue.length === 0) return;
    sending = true;
    var item = sendQueue[0];
    Pebble.sendAppMessage(item.msg, function() {
        sendQueue.shift();
        sending = false;
        pumpSendQueue();
    }, function() {
        item.tries++;
        console.log("sendAppMessage failed (attempt " + item.tries + ")");
        if (item.tries >= 3) sendQueue.shift();
        sending = false;
        setTimeout(pumpSendQueue, 300);
    });
}

function sendToWatch(msg) {
    sendQueue.push({ msg: msg, tries: 0 });
    pumpSendQueue();
}

function sendCards(text) {
    var msg = {};
    msg[KEY_CARDS] = text;
    sendToWatch(msg);
}

function sendStatus(text) {
    var msg = {};
    msg[KEY_STATUS] = text;
    sendToWatch(msg);
}

function sendSchedule(text, routeNumber) {
    var msg = {};
    msg[KEY_SCHEDULE] = text;
    if (routeNumber) msg[KEY_ROUTE] = String(routeNumber);
    sendToWatch(msg);
}

function postJson(path, body, onData, onFail) {
    var xhr = new XMLHttpRequest();
    xhr.timeout = 10000;
    xhr.onload = function() {
        if (xhr.status < 200 || xhr.status >= 300) {
            console.log(path + " HTTP " + xhr.status);
            onFail("Server Error");
            return;
        }
        var data;
        try {
            data = JSON.parse(xhr.responseText);
        } catch (err) {
            console.log(path + " parse error: " + err);
            onFail("Data Error");
            return;
        }
        onData(data);
    };
    xhr.onerror = function() {
        console.log(path + " XHR error");
        onFail("Network Error");
    };
    xhr.ontimeout = function() {
        console.log(path + " timed out");
        onFail("Timed Out");
    };
    xhr.open("POST", API_BASE + path);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send(JSON.stringify(body));
}

// --- Formatting ---

function pad2(n) {
    return (n < 10 ? "0" : "") + n;
}

// "Now", "5m", "1h", "1h 5m" -- with a trailing "*" for realtime estimates
function fmtMins(mins, realtime) {
    var suffix = realtime ? "*" : "";
    if (mins < 1) return "Now" + suffix;
    if (mins < 60) return mins + "m" + suffix;
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    return h + "h" + (m > 0 ? " " + m + "m" : "") + suffix;
}

// The API's *Utc fields are UTC, but a timestamp without a zone designator
// would be parsed as phone-local time. Returns null for missing/placeholder values.
function parseUtc(value) {
    if (!value) return null;
    var str = String(value);
    if (str.indexOf("0001-01-01") === 0) return null;
    if (!/(Z|[+-]\d\d:?\d\d)$/i.test(str)) str += "Z";
    var date = new Date(str);
    return isNaN(date.getTime()) ? null : date;
}

// Minutes until a stop time departs: { mins, realtime }, or null if it has no usable time
function minutesUntil(stopTime, now) {
    if (!stopTime) return null;
    var estimated = parseUtc(stopTime.estimatedDepartTimeUtc);
    var scheduled = parseUtc(stopTime.scheduledDepartTimeUtc);
    var realtime = !!stopTime.isRealtime && estimated !== null;
    var depart = realtime ? estimated : (scheduled || estimated);
    if (!depart) return null;
    return { mins: Math.round((depart - now) / 60000), realtime: realtime };
}

// "INBOUND"/"IN" => "In", "OUTBOUND"/"OUT" => "Out", anything else unchanged
function dirLabel(directionName) {
    var name = directionName ? String(directionName).trim() : "";
    var upper = name.toUpperCase();
    if (/\bIN(BOUND)?\b/.test(upper)) return "In";
    if (/\bOUT(BOUND)?\b/.test(upper)) return "Out";
    return name;
}

// One card line for a direction, e.g. "In: 5m*" ("--" when there is no upcoming bus).
// Returns { text, mins } where mins is null when there is no upcoming bus.
function formatLine(combo, now) {
    var timeStr = "--";
    var mins = null;
    var times = combo.time.nextStopTimes || [];
    for (var i = 0; i < times.length; i++) {
        var until = minutesUntil(times[i], now);
        // Skip buses that have already left
        if (until && until.mins >= 0) {
            timeStr = fmtMins(until.mins, until.realtime);
            mins = until.mins;
            break;
        }
    }
    return { text: (dirLabel(combo.static.dirName) || "?") + ": " + timeStr, mins: mins };
}

// Orders route numbers numerically, then by suffix: "9" < "9C" < "14"
function compareRouteNumbers(a, b) {
    var numA = parseInt(a, 10);
    var numB = parseInt(b, 10);
    if (isNaN(numA) !== isNaN(numB)) return isNaN(numA) ? 1 : -1;
    if (!isNaN(numA) && numA !== numB) return numA - numB;
    return a < b ? -1 : (a > b ? 1 : 0);
}

// --- Nearby routes (main list) ---

function buildCards(routesForRequest, routeMap, timesData) {
    var now = new Date();
    var cards = [];
    var nextTimes = {};

    for (var i = 0; i < routesForRequest.length; i++) {
        var rKey = routesForRequest[i].routeKey;
        var staticInfo = routeMap[rKey];

        // Find corresponding time data
        var timeInfo = null;
        for (var k = 0; k < timesData.length; k++) {
            if (timesData[k] && timesData[k].routeKey === rKey) {
                timeInfo = timesData[k];
                break;
            }
        }

        if (!timeInfo) continue;

        var inStop = null;
        var outStop = null;
        var otherStops = [];

        // Sort the available stops in timeInfo into IN/OUT/Other
        var timeStops = timeInfo.nearbyStops || [];
        for (var j = 0; j < timeStops.length; j++) {
            var ts = timeStops[j];
            var staticStop = ts ? staticInfo.stops[ts.directionKey] : null;
            if (!staticStop) continue;

            var combo = { static: staticStop, time: ts };
            var label = dirLabel(staticStop.dirName);

            // Remember every upcoming time for this route's schedule view
            var routeNumber = String(staticInfo.number).trim();
            var upcoming = ts.nextStopTimes || [];
            for (var n = 0; n < upcoming.length; n++) {
                if (!nextTimes[routeNumber]) nextTimes[routeNumber] = [];
                nextTimes[routeNumber].push({ label: label, stopTime: upcoming[n] });
            }
            if (label === "In" && !inStop) {
                inStop = combo;
            } else if (label === "Out" && !outStop) {
                outStop = combo;
            } else {
                otherStops.push(combo);
            }
        }

        var line1;
        if (inStop) {
            line1 = formatLine(inStop, now);
        } else if (otherStops.length > 0) {
            line1 = formatLine(otherStops.shift(), now);
        } else {
            line1 = { text: "In: No Stop", mins: null };
        }

        var line2;
        if (outStop) {
            line2 = formatLine(outStop, now);
        } else if (otherStops.length > 0) {
            line2 = formatLine(otherStops.shift(), now);
        } else {
            line2 = { text: "Out: No Stop", mins: null };
        }

        // Soonest of the two directions; Infinity when neither has an upcoming bus
        var soonest = Math.min(line1.mins === null ? Infinity : line1.mins,
                               line2.mins === null ? Infinity : line2.mins);
        cards.push({
            soonest: soonest,
            number: String(staticInfo.number).trim(),
            text: staticInfo.number + " " + staticInfo.name + "\n" + line1.text + "\n" + line2.text
        });
    }

    lastRouteNextTimes = nextTimes;

    // Soonest bus first, ties (and routes with no upcoming bus) by route number
    cards.sort(function(a, b) {
        if (a.soonest !== b.soonest) return a.soonest < b.soonest ? -1 : 1;
        return compareRouteNumbers(a.number, b.number);
    });

    return cards.slice(0, MAX_CARDS).map(function(c) { return c.text; });
}

function requestNearbyRoutesAndTimes() {
    navigator.geolocation.getCurrentPosition(function(pos) {
        var lat = pos.coords.latitude;
        var lon = pos.coords.longitude;
        console.log("Location: " + lat + ", " + lon);

        postJson("/Home/GetNearbyRoutes", {
            latitude: lat,
            longitude: lon,
            minRadius: null,
            maxRadius: 9000,
            favouriteRoutes: []
        }, function(routesData) {
            var routeResults = (routesData && routesData.routeResults) ? routesData.routeResults : [];
            console.log("Got routes: " + routeResults.length);

            if (routeResults.length === 0) {
                sendStatus("No routes found nearby");
                return;
            }

            var routesForRequest = [];
            var routeMap = {}; // Key: routeKey
            var routeStopCodes = {};

            for (var i = 0; i < routeResults.length; i++) {
                var r = routeResults[i];
                if (!r) continue;
                var nearbyStops = r.nearbyStops || [];

                // Build map for static info
                routeMap[r.routeKey] = {
                    number: r.routeNumber,
                    name: r.routeName,
                    stops: {} // Key: directionKey
                };

                // Remember ALL stop codes for this route (IN and OUT) for later stop-estimate requests
                var codes = [];
                var seen = {};
                var stopsPayload = [];
                for (var j = 0; j < nearbyStops.length; j++) {
                    var s = nearbyStops[j];
                    if (!s) continue;

                    if (s.stopCode != null && !seen[String(s.stopCode)]) {
                        seen[String(s.stopCode)] = true;
                        codes.push(String(s.stopCode));
                    }

                    routeMap[r.routeKey].stops[s.directionKey] = {
                        dirName: s.directionName
                    };
                    stopsPayload.push({
                        stopCode: s.stopCode,
                        directionKey: s.directionKey
                    });
                }
                if (codes.length > 0) routeStopCodes[String(r.routeNumber).trim()] = codes;

                routesForRequest.push({
                    routeKey: r.routeKey,
                    nearbyStops: stopsPayload
                });
            }
            lastRouteStopCodes = routeStopCodes;

            // Second Request for Times
            postJson("/Home/GetNextStopTimes", { routes: routesForRequest }, function(timesData) {
                if (!Array.isArray(timesData)) timesData = [];
                console.log("Got times data, length: " + timesData.length);

                var cards = buildCards(routesForRequest, routeMap, timesData);
                console.log("Sending " + cards.length + " cards");

                if (cards.length === 0) {
                    sendStatus("No active buses found");
                } else {
                    sendCards(cards.join("\n\n"));
                }
            }, function(reason) {
                sendStatus(reason + "\n(Times)");
            });
        }, function(reason) {
            sendStatus(reason + "\n(Routes)");
        });
    }, function(err) {
        console.log("Geo Error: " + err.message);
        sendStatus("Location Error\n(" + err.code + ")");
    }, {
        timeout: 10000,
        maximumAge: 60000
    });
}

// --- Stop estimates (schedule view for one route) ---

function requestStopEstimates(stopCodes, dateStr, routeNumber) {
    var requests = stopCodes.length * 2; // schedule + realtime estimates per stop
    var pending = requests;
    var failed = 0;
    var schedules = [];
    var estimates = [];

    function addLine(lines, seen, label, stopTime, now) {
        var until = minutesUntil(stopTime, now);
        if (!until || until.mins < 0) return;
        if (seen[label + "|" + until.mins]) return;

        seen[label + "|" + until.mins] = true;
        lines.push({
            mins: until.mins,
            text: (label ? label + ": " : "") + fmtMins(until.mins, until.realtime)
        });
    }

    // These stops serve other routes too; only keep the selected one
    function forRoute(list) {
        return list.filter(function(s) {
            return s.stopTimes && s.routeNumber != null && String(s.routeNumber).trim() === routeNumber;
        });
    }

    function finish() {
        console.log("Got " + schedules.length + " schedules, " + estimates.length + " estimates");

        var now = new Date();
        var lines = [];
        var seen = {}; // "label|mins" already listed
        var i, j;

        // Realtime estimates by trip, to overlay on the day's schedule
        var routeEstimates = forRoute(estimates);
        var estimateByTrip = {};
        for (i = 0; i < routeEstimates.length; i++) {
            for (j = 0; j < routeEstimates[i].stopTimes.length; j++) {
                var est = routeEstimates[i].stopTimes[j];
                if (est && est.tripPointId) estimateByTrip[est.tripPointId] = est;
            }
        }

        var usedTrips = {};
        var routeSchedules = forRoute(schedules);
        for (i = 0; i < routeSchedules.length; i++) {
            var label = dirLabel(routeSchedules[i].directionName);
            for (j = 0; j < routeSchedules[i].stopTimes.length; j++) {
                var stopTime = routeSchedules[i].stopTimes[j];
                if (!stopTime || stopTime.isCancelled) continue;

                var live = stopTime.tripPointId ? estimateByTrip[stopTime.tripPointId] : null;
                if (live) usedTrips[stopTime.tripPointId] = true;
                addLine(lines, seen, label, (live && !live.isCancelled) ? live : stopTime, now);
            }
        }

        // Estimates for trips the schedule didn't list (or when the schedule failed to load)
        for (i = 0; i < routeEstimates.length; i++) {
            for (j = 0; j < routeEstimates[i].stopTimes.length; j++) {
                var extra = routeEstimates[i].stopTimes[j];
                if (!extra || extra.isCancelled || usedTrips[extra.tripPointId]) continue;
                addLine(lines, seen, dirLabel(routeEstimates[i].directionName), extra, now);
            }
        }

        // Nothing loaded: fall back to the upcoming times the route list already showed
        if (lines.length === 0) {
            var cached = lastRouteNextTimes[routeNumber] || [];
            for (i = 0; i < cached.length; i++) {
                addLine(lines, seen, cached[i].label, cached[i].stopTime, now);
            }
        }

        if (lines.length === 0 && requests > 0 && failed === requests) {
            sendSchedule("Network Error", routeNumber);
            return;
        }

        // Sort by time so IN and OUT are interleaved by departure time
        lines.sort(function(a, b) { return a.mins - b.mins; });
        var outLines = lines.slice(0, MAX_SCHEDULE_ITEMS).map(function(x) { return x.text; });

        sendSchedule(outLines.length > 0 ? outLines.join("\n") : "No upcoming buses", routeNumber);
    }

    function maybeDone() {
        pending--;
        if (pending <= 0) finish();
    }

    function load(path, stopCode, into) {
        postJson(path, { stopCode: String(stopCode), date: dateStr }, function(data) {
            var list = (data && data.routeStopSchedules) ? data.routeStopSchedules : [];
            for (var i = 0; i < list.length; i++) {
                if (list[i]) into.push(list[i]);
            }
            maybeDone();
        }, function() {
            failed++;
            maybeDone();
        });
    }

    if (requests === 0) {
        finish();
        return;
    }

    stopCodes.forEach(function(stopCode) {
        load("/Schedule/GetStopSchedules", stopCode, schedules);
        load("/Schedule/GetStopEstimates", stopCode, estimates);
    });
}

Pebble.addEventListener("appmessage", function(e) {
    var payload = (e && e.payload) ? e.payload : {};
    console.log("Got appmessage from watch: " + JSON.stringify(payload));

    // Watch requests location/routes
    if (payload[KEY_REQUEST_NEARBY] === 1) {
        requestNearbyRoutesAndTimes();
        return;
    }

    // Watch requests stop estimates for one route
    if (payload[KEY_REQUEST_SCHEDULE] === 1) {
        var routeNumber = payload[KEY_ROUTE] != null ? String(payload[KEY_ROUTE]).trim() : "";

        // Use all stop codes for this route (IN + OUT) from the last nearby fetch
        var stopCodes = lastRouteStopCodes[routeNumber] || [];

        // Always use today's date for the API so we get upcoming times
        var d = new Date();
        var dateStr = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());

        console.log("Stop estimates: stopCodes=" + JSON.stringify(stopCodes) + " date=" + dateStr + " route=" + routeNumber);

        requestStopEstimates(stopCodes, dateStr, routeNumber);
        return;
    }
});
