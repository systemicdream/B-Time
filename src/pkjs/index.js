console.log("B-Time loaded");

Pebble.addEventListener("ready", function() {
    console.log("Ready");
});

// Persist across appmessage: routeNumber -> array of stopCodes from last GetNearbyRoutes (IN and OUT)
var lastRouteStopCodes = {};

Pebble.addEventListener("appmessage", function(e) {
    console.log("Got appmessage from watch: " + JSON.stringify(e && e.payload ? e.payload : {}));

    function requestNearbyRoutesAndTimes() {
        navigator.geolocation.getCurrentPosition(function(pos) {
            var lat = pos.coords.latitude;
            var lon = pos.coords.longitude;
            console.log("Location: " + lat + ", " + lon);

            var xhr = new XMLHttpRequest();
            xhr.timeout = 10000;

            xhr.onload = function() {
                try {
                    var routesData = JSON.parse(xhr.responseText);
                    console.log("Got routes: " + (routesData.routeResults ? routesData.routeResults.length : 0));

                    if (!routesData.routeResults || routesData.routeResults.length === 0) {
                        Pebble.sendAppMessage({ 2: "No routes found\nnearby." });
                        return;
                    }

                    var routesForRequest = [];
                    var routeMap = {}; // Key: routeKey

                    for (var i = 0; i < routesData.routeResults.length; i++) {
                        var r = routesData.routeResults[i];

                        // Build map for static info
                        routeMap[r.routeKey] = {
                            number: r.routeNumber,
                            name: r.routeName,
                            stops: {} // Key: directionKey
                        };

                        // Remember ALL stop codes for this route (IN and OUT) for later stop-estimate requests
                        if (r.nearbyStops && r.nearbyStops.length > 0) {
                            var codes = [];
                            var seen = {};
                            for (var k = 0; k < r.nearbyStops.length; k++) {
                                var sc = r.nearbyStops[k].stopCode;
                                if (sc != null) {
                                    var key = String(sc);
                                    if (!seen[key]) {
                                        seen[key] = true;
                                        codes.push(key);
                                    }
                                }
                            }
                            if (codes.length > 0) lastRouteStopCodes[String(r.routeNumber)] = codes;
                        }

                        var stopsPayload = [];
                        for (var j = 0; j < r.nearbyStops.length; j++) {
                            var s = r.nearbyStops[j];
                            routeMap[r.routeKey].stops[s.directionKey] = {
                                dirName: s.directionName,
                                distance: s.distance // meters
                            };
                            stopsPayload.push({
                                stopCode: s.stopCode,
                                directionKey: s.directionKey
                            });
                        }

                        routesForRequest.push({
                            routeKey: r.routeKey,
                            nearbyStops: stopsPayload
                        });
                    }

                    // Second Request for Times
                    var xhr2 = new XMLHttpRequest();
                    xhr2.timeout = 10000;

                    xhr2.onload = function() {
                        try {
                            var timesData = JSON.parse(xhr2.responseText);
                            console.log("Got times data, length: " + timesData.length);

                            var cards = [];

                            // Iterate over the original routes to maintain order
                            for (var i = 0; i < routesForRequest.length; i++) {
                                var rKey = routesForRequest[i].routeKey;
                                var staticInfo = routeMap[rKey];

                                // Find corresponding time data
                                var timeInfo = null;
                                for (var k = 0; k < timesData.length; k++) {
                                    if (timesData[k].routeKey === rKey) {
                                        timeInfo = timesData[k];
                                        break;
                                    }
                                }

                                if (!timeInfo) continue;

                                var inStop = null;
                                var outStop = null;
                                var otherStops = [];

                                // Iterate available stops in timeInfo to sort into IN/OUT/Other
                                if (timeInfo.nearbyStops) {
                                    for (var j = 0; j < timeInfo.nearbyStops.length; j++) {
                                        var ts = timeInfo.nearbyStops[j];
                                        var dirKey = ts.directionKey;
                                        var staticStop = staticInfo.stops[dirKey];
                                        if (!staticStop) continue;

                                        var combo = {
                                            static: staticStop,
                                            time: ts
                                        };

                                        var dName = staticStop.dirName ? staticStop.dirName.toUpperCase() : "";
                                        if (dName.indexOf("IN") !== -1) {
                                            inStop = combo;
                                        } else if (dName.indexOf("OUT") !== -1) {
                                            outStop = combo;
                                        } else {
                                            otherStops.push(combo);
                                        }
                                    }
                                }

                                // Helper function to format a single line
                                function formatLine(combo) {
                                    if (!combo) return null;

                                    var dName = combo.static.dirName || "";

                                    var timeStr = "--";
                                    if (combo.time.nextStopTimes && combo.time.nextStopTimes.length > 0) {
                                        var nt = combo.time.nextStopTimes[0];
                                        var tVal = nt.isRealtime ? nt.estimatedDepartTimeUtc : nt.scheduledDepartTimeUtc;
                                        if (tVal) {
                                            var ms = new Date(tVal) - new Date();
                                            var mins = Math.round(ms / 60000);
                                            timeStr = mins + "m";
                                            if (nt.isRealtime) timeStr += "*";
                                        }
                                    }

                                    // Determine label
                                    var label = dName;
                                    if (dName.toUpperCase() === "IN" || dName.toUpperCase().indexOf("INBOUND") !== -1) label = "In";
                                    else if (dName.toUpperCase() === "OUT" || dName.toUpperCase().indexOf("OUTBOUND") !== -1) label = "Out";

                                    return label + ": " + timeStr;
                                }

                                var line1 = "";
                                var line2 = "";

                                // Fill Line 1
                                if (inStop) {
                                    line1 = formatLine(inStop);
                                } else if (otherStops.length > 0) {
                                    line1 = formatLine(otherStops.shift());
                                } else {
                                    line1 = "In: No Stop";
                                }

                                // Fill Line 2
                                if (outStop) {
                                    line2 = formatLine(outStop);
                                } else if (otherStops.length > 0) {
                                    line2 = formatLine(otherStops.shift());
                                } else {
                                    line2 = "(No Outbound)";
                                }

                                // Title
                                var title = staticInfo.number + " " + staticInfo.name;

                                cards.push(title + "\n" + line1 + "\n" + line2);
                            }

                            var fullText = cards.join("\n\n");
                            console.log("Sending " + cards.length + " cards");
                            if (fullText.length === 0) fullText = "No active\nbuses found.";

                            Pebble.sendAppMessage({ 2: fullText });
                        } catch (e) {
                            console.log("Time Parse Error: " + e);
                            Pebble.sendAppMessage({ 2: "Data Error\n(Times)" });
                        }
                    };

                    xhr2.onerror = function() {
                        console.log("XHR2 Error");
                        Pebble.sendAppMessage({ 2: "Network Error\n(Times)" });
                    };
                    xhr2.open("POST", "https://planmyride.blinetransit.com/Home/GetNextStopTimes");
                    xhr2.setRequestHeader("Content-Type", "application/json");
                    xhr2.send(JSON.stringify({ routes: routesForRequest }));
                } catch (e) {
                    console.log("Route Parse Error: " + e);
                    Pebble.sendAppMessage({ 2: "Data Error\n(Routes)" });
                }
            };

            xhr.onerror = function() {
                console.log("XHR1 Error");
                Pebble.sendAppMessage({ 2: "Network Error\n(Routes)" });
            };
            xhr.open("POST", "https://planmyride.blinetransit.com/Home/GetNearbyRoutes");
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.send(JSON.stringify({
                latitude: lat,
                longitude: lon,
                minRadius: null,
                maxRadius: 9000,
                favouriteRoutes: []
            }));
        }, function(err) {
            console.log("Geo Error: " + err.message);
            Pebble.sendAppMessage({ 2: "Location Error\n(" + err.code + ")" });
        }, {
            timeout: 10000,
            maximumAge: 60000
        });
    }

    function requestStopEstimates(stopCodes, dateStr, routeNumberFilter) {
        if (!Array.isArray(stopCodes)) stopCodes = [String(stopCodes)];

        var pending = stopCodes.length;
        var mergedSchedules = [];

        function maybeDone() {
            pending--;
            if (pending > 0) return;

            var schedules = mergedSchedules.slice();

            if (routeNumberFilter !== undefined && routeNumberFilter !== null && String(routeNumberFilter).trim().length > 0) {
                var filter = String(routeNumberFilter).trim();
                schedules = schedules.filter(function(s) {
                    if (!s || s.routeNumber == null) return false;
                    return String(s.routeNumber).trim() === filter;
                });
            }

            if (schedules.length === 0 && mergedSchedules.length > 0) {
                schedules = mergedSchedules;
            }

            console.log("Got stop estimates: " + mergedSchedules.length + " total, " + schedules.length + " after filter");

            var now = new Date();
            var lines = [];

            for (var i = 0; i < schedules.length; i++) {
                var s = schedules[i];
                if (!s || !s.stopTimes || !s.routeNumber) continue;

                var dir = (s.directionName || "").toUpperCase();
                if (dir.indexOf("IN") !== -1) dir = "In";
                else if (dir.indexOf("OUT") !== -1) dir = "Out";
                var routeLabel = String(s.routeNumber) + " " + (dir ? dir : "");

                for (var j = 0; j < s.stopTimes.length; j++) {
                    var st = s.stopTimes[j];
                    if (!st) continue;

                    var tVal = st.estimatedDepartTimeUtc || st.scheduledDepartTimeUtc;
                    if (!tVal || String(tVal).indexOf("0001-01-01") === 0) continue;

                    var dep = new Date(tVal);
                    var mins = Math.round((dep - now) / 60000);
                    if (mins < -5) continue;

                    var label = mins < 0 ? "Now" : (mins + "m" + (st.isRealtime ? "*" : ""));
                    lines.push({ mins: mins, text: routeLabel + " " + label });
                    if (lines.length >= 50) break;
                }
                if (lines.length >= 50) break;
            }

            // Sort by time so IN and OUT are interleaved by departure time
            lines.sort(function(a, b) { return a.mins - b.mins; });
            var outLines = lines.slice(0, 25).map(function(x) { return x.text; });

            if (outLines.length === 0) {
                outLines.push("No upcoming buses");
            }

            Pebble.sendAppMessage({ 3: outLines.join("\n") });
        }

        if (stopCodes.length === 0) {
            Pebble.sendAppMessage({ 3: "No upcoming buses" });
            return;
        }

        for (var idx = 0; idx < stopCodes.length; idx++) {
            (function(stopCode) {
                var xhr = new XMLHttpRequest();
                xhr.timeout = 10000;
                xhr.onload = function() {
                    try {
                        var data = JSON.parse(xhr.responseText);
                        var list = (data && data.routeStopSchedules) ? data.routeStopSchedules : [];
                        for (var i = 0; i < list.length; i++) {
                            if (list[i]) mergedSchedules.push(list[i]);
                        }
                    } catch (err) {
                        console.log("Stop Estimates Parse Error for stop " + stopCode + ": " + err);
                    }
                    maybeDone();
                };
                xhr.onerror = function() {
                    console.log("Stop Estimates XHR Error for stop " + stopCode);
                    maybeDone();
                };
                xhr.open("POST", "https://planmyride.blinetransit.com/Schedule/GetStopEstimates");
                xhr.setRequestHeader("Content-Type", "application/json");
                xhr.send(JSON.stringify({ stopCode: String(stopCode), date: String(dateStr) }));
            })(stopCodes[idx]);
        }
    }

    var payload = (e && e.payload) ? e.payload : {};

    // Existing behavior: watch requests location/routes with key 99
    if (payload["99"] === 1 || payload[99] === 1) {
        requestNearbyRoutesAndTimes();
        return;
    }

    // New behavior: watch requests stop estimates with key 100
    if (payload["100"] === 1 || payload[100] === 1) {
        var routeFilter = payload["103"] || payload[103] || null;
        if (routeFilter !== null) routeFilter = String(routeFilter).trim();

        // Use all stop codes for this route (IN + OUT) from the last nearby fetch; fallback to single payload or 173
        var stopCodes = [];
        if (routeFilter && lastRouteStopCodes[routeFilter] && lastRouteStopCodes[routeFilter].length > 0) {
            stopCodes = lastRouteStopCodes[routeFilter];
        } else {
            var fallback = payload["101"] || payload[101] || "173";
            stopCodes = [String(fallback)];
        }

        // Always use today's date for the API so we get upcoming times (ignore watch date)
        var d = new Date();
        var dateStr = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

        console.log("Stop estimates: stopCodes=" + JSON.stringify(stopCodes) + " date=" + dateStr + " routeFilter=" + (routeFilter || "(none)"));

        requestStopEstimates(stopCodes, dateStr, routeFilter);
        return;
    }
});
