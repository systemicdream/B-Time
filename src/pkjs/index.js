console.log("B-Time loaded");

Pebble.addEventListener("ready", function() {
    console.log("Ready");
});

Pebble.addEventListener("appmessage", function(e) {
    console.log("Got appmessage from watch");

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
                            function formatLine(combo, prefixDefault) {
                                if (!combo) return null;
                                
                                var dName = combo.static.dirName || "";
                                var distMeters = combo.static.distance;
                                var distFt = Math.round(distMeters * 3.28084);
                                var distStr = distFt + "ft";
                                if (distFt > 1320) { // > 0.25 mile
                                    distStr = (distFt / 5280).toFixed(1) + "mi";
                                }

                                var timeStr = "--";
                                var isLive = false;
                                
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
                                
                                return label + ": " + timeStr + " (" + distStr + ")";
                            }

                            var line1 = "";
                            var line2 = "";

                            // Fill Line 1
                            if (inStop) {
                                line1 = formatLine(inStop, "In: ");
                            } else if (otherStops.length > 0) {
                                line1 = formatLine(otherStops.shift(), "");
                            } else {
                                line1 = "In: No Stop";
                            }

                            // Fill Line 2
                            if (outStop) {
                                line2 = formatLine(outStop, "Out: ");
                            } else if (otherStops.length > 0) {
                                line2 = formatLine(otherStops.shift(), "");
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
                
                xhr2.onerror = function() { console.log("XHR2 Error"); Pebble.sendAppMessage({ 2: "Network Error\n(Times)" }); };
                xhr2.open("POST", "https://planmyride.blinetransit.com/Home/GetNextStopTimes");
                xhr2.setRequestHeader("Content-Type", "application/json");
                xhr2.send(JSON.stringify({ routes: routesForRequest }));

            } catch (e) {
                console.log("Route Parse Error: " + e);
                Pebble.sendAppMessage({ 2: "Data Error\n(Routes)" });
            }
        };

        xhr.onerror = function() { console.log("XHR1 Error"); Pebble.sendAppMessage({ 2: "Network Error\n(Routes)" }); };
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
});
