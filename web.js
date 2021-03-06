/************************************************************
 *
 * Project: rdflib.js, originally part of Tabulator project
 *
 * File: web.js
 *
 * Description: contains functions for requesting/fetching/retracting
 *  This implements quite a lot of the web architecture.
 * A fetcher is bound to a specific knowledge base graph, into which
 * it loads stuff and into which it writes its metadata
 * @@ The metadata should be optionally a separate graph
 *
 * - implements semantics of HTTP headers, Internet Content Types
 * - selects parsers for rdf/xml, n3, rdfa, grddl
 *
 * Dependencies:
 *
 * needs: util.js uri.js term.js rdfparser.js rdfa.js n3parser.js
 *      identity.js sparql.js jsonparser.js
 *
 * If jQuery is defined, it uses jQuery.ajax, else is independent of jQuery
 *
 ************************************************************/

/**
 * Things to test: callbacks on request, refresh, retract
 *   loading from HTTP, HTTPS, FTP, FILE, others?
 * To do:
 * Firing up a mail client for mid:  (message:) URLs
 */

var asyncLib = require('async');
var jsonld = require('jsonld');
var N3 = require('n3');

$rdf.Fetcher = function(store, timeout, async) {
    this.store = store
    this.thisURI = "http://dig.csail.mit.edu/2005/ajar/ajaw/rdf/sources.js" + "#SourceFetcher" // -- Kenny
    this.timeout = timeout ? timeout : 30000
    this.async = async != null ? async : true
    this.appNode = this.store.bnode(); // Denoting this session
    this.store.fetcher = this; //Bi-linked
    this.requested = {} ;
    // this.requested[uri] states:
    //   undefined     no record of web access or records reset
    //   true          has been requested, XHR in progress
    //   'done'        received, Ok
    //   403           HTTP status unauthorized
    //   404           Ressource does not exist. Can be created etc.
    //   'redirected'  In attempt to counter CORS problems retried.
    //   other strings mean various other erros, such as parse errros.
    //

    this.fetchCallbacks = {}; // fetchCallbacks[uri].push(callback)

    this.nonexistant = {}; // keep track of explict 404s -> we can overwrite etc
    this.lookedUp = {}
    this.handlers = []
    this.mediatypes = {}
    var sf = this
    var kb = this.store;
    var ns = {} // Convenience namespaces needed in this module:
    // These are delibertely not exported as the user application should
    // make its own list and not rely on the prefixes used here,
    // and not be tempted to add to them, and them clash with those of another
    // application.
    ns.link = $rdf.Namespace("http://www.w3.org/2007/ont/link#");
    ns.http = $rdf.Namespace("http://www.w3.org/2007/ont/http#");
    ns.httph = $rdf.Namespace("http://www.w3.org/2007/ont/httph#");
    ns.rdf = $rdf.Namespace("http://www.w3.org/1999/02/22-rdf-syntax-ns#");
    ns.rdfs = $rdf.Namespace("http://www.w3.org/2000/01/rdf-schema#");
    ns.dc = $rdf.Namespace("http://purl.org/dc/elements/1.1/");


    $rdf.Fetcher.crossSiteProxy = function(uri) {
        if ($rdf.Fetcher.crossSiteProxyTemplate)
          return $rdf.Fetcher.crossSiteProxyTemplate.replace('{uri}', encodeURIComponent(uri));
        else return undefined;
    };
    $rdf.Fetcher.RDFXMLHandler = function(args) {
        if (args) {
            this.dom = args[0]
        }
        this.handlerFactory = function(xhr) {
            xhr.handle = function(cb) {
                //sf.addStatus(xhr.req, 'parsing soon as RDF/XML...');
                var kb = sf.store;
                if (!this.dom) this.dom = $rdf.Util.parseXML(xhr.responseText);
                var root = this.dom.documentElement;
                if (root.nodeName == 'parsererror') { //@@ Mozilla only See issue/issue110
                    sf.failFetch(xhr, "Badly formed XML in " + xhr.resource.uri); //have to fail the request
                    throw new Error("Badly formed XML in " + xhr.resource.uri); //@@ Add details
                }
                // Find the last URI we actual URI in a series of redirects
                // (xhr.resource.uri is the original one)
                var lastRequested = kb.any(xhr.req, ns.link('requestedURI'));
                if (!lastRequested) {
                    lastRequested = xhr.resource;
                } else {
                    lastRequested = kb.sym(lastRequested.value);
                }
                var parser = new $rdf.RDFParser(kb);
                // sf.addStatus(xhr.req, 'parsing as RDF/XML...');
                parser.parse(this.dom, lastRequested.uri, lastRequested);
                if (!xhr.options.noMeta) {
                    kb.add(lastRequested, ns.rdf('type'), ns.link('RDFDocument'), sf.appNode);
                }
                cb();
            }
        }
    };
    $rdf.Fetcher.RDFXMLHandler.term = this.store.sym(this.thisURI + ".RDFXMLHandler");
    $rdf.Fetcher.RDFXMLHandler.toString = function() {
        return "RDFXMLHandler"
    };
    $rdf.Fetcher.RDFXMLHandler.register = function(sf) {
        sf.mediatypes['application/rdf+xml'] = {}
    };
    $rdf.Fetcher.RDFXMLHandler.pattern = new RegExp("application/rdf\\+xml");

    // This would much better use on-board XSLT engine. @@
    $rdf.Fetcher.doGRDDL = function(kb, doc, xslturi, xmluri) {
        sf.requestURI('http://www.w3.org/2005/08/' + 'online_xslt/xslt?' + 'xslfile=' + escape(xslturi) + '&xmlfile=' + escape(xmluri), doc)
    };

    $rdf.Fetcher.XHTMLHandler = function(args) {
        if (args) {
            this.dom = args[0]
        }
        this.handlerFactory = function(xhr) {
            xhr.handle = function(cb) {
                var relation, reverse;
                if (!this.dom) {
                    this.dom = $rdf.Util.parseXML(xhr.responseText)
                }
                var kb = sf.store;

                // dc:title
                var title = this.dom.getElementsByTagName('title')
                if (title.length > 0) {
                    kb.add(xhr.resource, ns.dc('title'), kb.literal(title[0].textContent), xhr.resource)
                    // $rdf.log.info("Inferring title of " + xhr.resource)
                }

                // link rel
                var links = this.dom.getElementsByTagName('link');
                for (var x = links.length - 1; x >= 0; x--) { // @@ rev
                    relation = links[x].getAttribute('rel'); 
                    reverse = false;
                    if (!relation) {
                        relation = links[x].getAttribute('rev'); 
                        reverse = true;
                    }
                    if (relation) {
                        sf.linkData(xhr, relation,
                        links[x].getAttribute('href'), xhr.resource, reverse);
                    }
                }

                //GRDDL
                var head = this.dom.getElementsByTagName('head')[0]
                if (head) {
                    var profile = head.getAttribute('profile');
                    if (profile && $rdf.uri.protocol(profile) == 'http') {
                        // $rdf.log.info("GRDDL: Using generic " + "2003/11/rdf-in-xhtml-processor.");
                         $rdf.Fetcher.doGRDDL(kb, xhr.resource, "http://www.w3.org/2003/11/rdf-in-xhtml-processor", xhr.resource.uri)
/*			sf.requestURI('http://www.w3.org/2005/08/'
					  + 'online_xslt/xslt?'
					  + 'xslfile=http://www.w3.org'
					  + '/2003/11/'
					  + 'rdf-in-xhtml-processor'
					  + '&xmlfile='
					  + escape(xhr.resource.uri),
				      xhr.resource)
                        */
                    } else {
                        // $rdf.log.info("GRDDL: No GRDDL profile in " + xhr.resource)
                    }
                }
                if (!xhr.options.noMeta) {
                    kb.add(xhr.resource, ns.rdf('type'), ns.link('WebPage'), sf.appNode);
                }
                // Do RDFa here

                if ($rdf.parseDOM_RDFa) {
                    $rdf.parseDOM_RDFa(this.dom, kb, xhr.resource.uri);
                }
                cb(); // Fire done callbacks
            }
        }
    };
    $rdf.Fetcher.XHTMLHandler.term = this.store.sym(this.thisURI + ".XHTMLHandler");
    $rdf.Fetcher.XHTMLHandler.toString = function() {
        return "XHTMLHandler"
    };
    $rdf.Fetcher.XHTMLHandler.register = function(sf) {
        sf.mediatypes['application/xhtml+xml'] = {
            'q': 0.3
        }
    };
    $rdf.Fetcher.XHTMLHandler.pattern = new RegExp("application/xhtml");


    /******************************************************/

    $rdf.Fetcher.XMLHandler = function() {
        this.handlerFactory = function(xhr) {
            xhr.handle = function(cb) {
                var kb = sf.store
                var dom = $rdf.Util.parseXML(xhr.responseText)

                // XML Semantics defined by root element namespace
                // figure out the root element
                for (var c = 0; c < dom.childNodes.length; c++) {
                    // is this node an element?
                    if (dom.childNodes[c].nodeType == 1) {
                        // We've found the first element, it's the root
                        var ns = dom.childNodes[c].namespaceURI;

                        // Is it RDF/XML?
                        if (ns != undefined && ns == ns['rdf']) {
                            sf.addStatus(xhr.req, "Has XML root element in the RDF namespace, so assume RDF/XML.")
                            sf.switchHandler('RDFXMLHandler', xhr, cb, [dom])
                            return
                        }
                        // it isn't RDF/XML or we can't tell
                        // Are there any GRDDL transforms for this namespace?
                        // @@ assumes ns documents have already been loaded
                        var xforms = kb.each(kb.sym(ns), kb.sym("http://www.w3.org/2003/g/data-view#namespaceTransformation"));
                        for (var i = 0; i < xforms.length; i++) {
                            var xform = xforms[i];
                            // $rdf.log.info(xhr.resource.uri + " namespace " + ns + " has GRDDL ns transform" + xform.uri);
                             $rdf.Fetcher.doGRDDL(kb, xhr.resource, xform.uri, xhr.resource.uri);
                        }
                        break
                    }
                }

                // Or it could be XHTML?
                // Maybe it has an XHTML DOCTYPE?
                if (dom.doctype) {
                    // $rdf.log.info("We found a DOCTYPE in " + xhr.resource)
                    if (dom.doctype.name == 'html' && dom.doctype.publicId.match(/^-\/\/W3C\/\/DTD XHTML/) && dom.doctype.systemId.match(/http:\/\/www.w3.org\/TR\/xhtml/)) {
                        sf.addStatus(xhr.req,"Has XHTML DOCTYPE. Switching to XHTML Handler.\n")
                        sf.switchHandler('XHTMLHandler', xhr, cb)
                        return
                    }
                }

                // Or what about an XHTML namespace?
                var html = dom.getElementsByTagName('html')[0]
                if (html) {
                    var xmlns = html.getAttribute('xmlns')
                    if (xmlns && xmlns.match(/^http:\/\/www.w3.org\/1999\/xhtml/)) {
                        sf.addStatus(xhr.req, "Has a default namespace for " + "XHTML. Switching to XHTMLHandler.\n")
                        sf.switchHandler('XHTMLHandler', xhr, cb)
                        return
                    }
                }

                // At this point we should check the namespace document (cache it!) and
                // look for a GRDDL transform
                // @@  Get namespace document <n>, parse it, look for  <n> grddl:namespaceTransform ?y
                // Apply ?y to   dom
                // We give up. What dialect is this?
                sf.failFetch(xhr, "Unsupported dialect of XML: not RDF or XHTML namespace, etc.\n"+xhr.responseText.slice(0,80));
            }
        }
    };
    $rdf.Fetcher.XMLHandler.term = this.store.sym(this.thisURI + ".XMLHandler");
    $rdf.Fetcher.XMLHandler.toString = function() {
        return "XMLHandler"
    };
    $rdf.Fetcher.XMLHandler.register = function(sf) {
        sf.mediatypes['text/xml'] = {
            'q': 0.2
        }
        sf.mediatypes['application/xml'] = {
            'q': 0.2
        }
    };
    $rdf.Fetcher.XMLHandler.pattern = new RegExp("(text|application)/(.*)xml");

    $rdf.Fetcher.HTMLHandler = function() {
        this.handlerFactory = function(xhr) {
            xhr.handle = function(cb) {
                var rt = xhr.responseText
                // We only handle XHTML so we have to figure out if this is XML
                // $rdf.log.info("Sniffing HTML " + xhr.resource + " for XHTML.");

                if (rt.match(/\s*<\?xml\s+version\s*=[^<>]+\?>/)) {
                    sf.addStatus(xhr.req, "Has an XML declaration. We'll assume " +
                        "it's XHTML as the content-type was text/html.\n")
                    sf.switchHandler('XHTMLHandler', xhr, cb)
                    return
                }

                // DOCTYPE
                // There is probably a smarter way to do this
                if (rt.match(/.*<!DOCTYPE\s+html[^<]+-\/\/W3C\/\/DTD XHTML[^<]+http:\/\/www.w3.org\/TR\/xhtml[^<]+>/)) {
                    sf.addStatus(xhr.req, "Has XHTML DOCTYPE. Switching to XHTMLHandler.\n")
                    sf.switchHandler('XHTMLHandler', xhr, cb)
                    return
                }

                // xmlns
                if (rt.match(/[^(<html)]*<html\s+[^<]*xmlns=['"]http:\/\/www.w3.org\/1999\/xhtml["'][^<]*>/)) {
                    sf.addStatus(xhr.req, "Has default namespace for XHTML, so switching to XHTMLHandler.\n")
                    sf.switchHandler('XHTMLHandler', xhr, cb)
                    return
                }


                // dc:title	                       //no need to escape '/' here
                var titleMatch = (new RegExp("<title>([\\s\\S]+?)</title>", 'im')).exec(rt);
                if (titleMatch) {
                    var kb = sf.store;
                    kb.add(xhr.resource, ns.dc('title'), kb.literal(titleMatch[1]), xhr.resource); //think about xml:lang later
                    kb.add(xhr.resource, ns.rdf('type'), ns.link('WebPage'), sf.appNode);
                    cb(); //doneFetch, not failed
                    return;
                }

                sf.failFetch(xhr, "Sorry, can't yet parse non-XML HTML")
            }
        }
    };
    $rdf.Fetcher.HTMLHandler.term = this.store.sym(this.thisURI + ".HTMLHandler");
    $rdf.Fetcher.HTMLHandler.toString = function() {
        return "HTMLHandler"
    };
    $rdf.Fetcher.HTMLHandler.register = function(sf) {
        sf.mediatypes['text/html'] = {
            'q': 0.3
        }
    };
    $rdf.Fetcher.HTMLHandler.pattern = new RegExp("text/html");

    /***********************************************/

    $rdf.Fetcher.TextHandler = function() {
        this.handlerFactory = function(xhr) {
            xhr.handle = function(cb) {
                // We only speak dialects of XML right now. Is this XML?
                var rt = xhr.responseText

                // Look for an XML declaration
                if (rt.match(/\s*<\?xml\s+version\s*=[^<>]+\?>/)) {
                    sf.addStatus(xhr.req, "Warning: "+xhr.resource + " has an XML declaration. We'll assume "
                        + "it's XML but its content-type wasn't XML.\n")
                    sf.switchHandler('XMLHandler', xhr, cb)
                    return
                }

                // Look for an XML declaration
                if (rt.slice(0, 500).match(/xmlns:/)) {
                    sf.addStatus(xhr.req, "May have an XML namespace. We'll assume "
                            + "it's XML but its content-type wasn't XML.\n")
                    sf.switchHandler('XMLHandler', xhr, cb)
                    return
                }

                // We give up finding semantics - this is not an error, just no data
                sf.addStatus(xhr.req, "Plain text document, no known RDF semantics.");
                sf.doneFetch(xhr, [xhr.resource.uri]);
//                sf.failFetch(xhr, "unparseable - text/plain not visibly XML")
//                dump(xhr.resource + " unparseable - text/plain not visibly XML, starts:\n" + rt.slice(0, 500)+"\n")

            }
        }
    };
    $rdf.Fetcher.TextHandler.term = this.store.sym(this.thisURI + ".TextHandler");
    $rdf.Fetcher.TextHandler.toString = function() {
        return "TextHandler";
    };
    $rdf.Fetcher.TextHandler.register = function(sf) {
        sf.mediatypes['text/plain'] = {
            'q': 0.1
        }
    }
    $rdf.Fetcher.TextHandler.pattern = new RegExp("text/plain");

    /***********************************************/

    $rdf.Fetcher.N3Handler = function() {
        this.handlerFactory = function(xhr) {
            xhr.handle = function(cb) {
                // Parse the text of this non-XML file
                $rdf.log.debug("web.js: Parsing as N3 " + xhr.resource.uri); // @@@@ comment me out
                //sf.addStatus(xhr.req, "N3 not parsed yet...")
                var rt = xhr.responseText
                var p = $rdf.N3Parser(kb, kb, xhr.resource.uri, xhr.resource.uri, null, null, "", null)
                //                p.loadBuf(xhr.responseText)
                try {
                    p.loadBuf(xhr.responseText)

                } catch (e) {
                    var msg = ("Error trying to parse " + xhr.resource + " as Notation3:\n" + e +':\n'+e.stack)
                    // dump(msg+"\n")
                    sf.failFetch(xhr, msg)
                    return;
                }

                sf.addStatus(xhr.req, "N3 parsed: " + p.statementCount + " triples in " + p.lines + " lines.")
                sf.store.add(xhr.resource, ns.rdf('type'), ns.link('RDFDocument'), sf.appNode);
                args = [xhr.resource.uri]; // Other args needed ever?
                sf.doneFetch(xhr, args)
            }
        }
    };
    $rdf.Fetcher.N3Handler.term = this.store.sym(this.thisURI + ".N3Handler");
    $rdf.Fetcher.N3Handler.toString = function() {
        return "N3Handler";
    }
    $rdf.Fetcher.N3Handler.register = function(sf) {
        sf.mediatypes['text/n3'] = {
            'q': '1.0'
        } // as per 2008 spec
        sf.mediatypes['application/x-turtle'] = {
            'q': 1.0
        } // pre 2008
        sf.mediatypes['text/turtle'] = {
            'q': 1.0
        } // pre 2008
    }
    $rdf.Fetcher.N3Handler.pattern = new RegExp("(application|text)/(x-)?(rdf\\+)?(n3|turtle)")

    /***********************************************/

    $rdf.Util.callbackify(this, ['request', 'recv', 'headers', 'load', 'fail', 'refresh', 'retract', 'done']);

    this.addHandler = function(handler) {
        sf.handlers.push(handler)
        handler.register(sf)
    }

    this.switchHandler = function(name, xhr, cb, args) {
        var kb = this.store; var handler = null;
        for (var i=0; i<this.handlers.length; i++) {
            if (''+this.handlers[i] == name) {
                handler = this.handlers[i];
            }
        }
        if (handler == undefined) {
            throw 'web.js: switchHandler: name='+name+' , this.handlers ='+this.handlers+'\n' +
                    'switchHandler: switching to '+handler+'; sf='+sf +
                    '; typeof $rdf.Fetcher='+typeof $rdf.Fetcher +
                    ';\n\t $rdf.Fetcher.HTMLHandler='+$rdf.Fetcher.HTMLHandler+'\n' +
                    '\n\tsf.handlers='+sf.handlers+'\n'
        }
        (new handler(args)).handlerFactory(xhr);
        xhr.handle(cb)
    }

    this.addStatus = function(req, status) {
        //<Debug about="parsePerformance">
        var now = new Date();
        status = "[" + now.getHours() + ":" + now.getMinutes() + ":" + now.getSeconds() + "." + now.getMilliseconds() + "] " + status;
        //</Debug>
        var kb = this.store
        var s = kb.the(req, ns.link('status'));
        if (s && s.append) {
            s.append(kb.literal(status));
        } else {
            $rdf.log.warn("web.js: No list to add to: " + s + ',' + status); // @@@
        };
    }

    // Record errors in the system on failure
    // Returns xhr so can just do return this.failfetch(...)
    this.failFetch = function(xhr, status) {
        this.addStatus(xhr.req, status)
        if (!xhr.options.noMeta) {
            kb.add(xhr.resource, ns.link('error'), status)
        }
        this.requested[$rdf.uri.docpart(xhr.resource.uri)] = xhr.status; // changed 2015 was false
        while (this.fetchCallbacks[xhr.resource.uri] && this.fetchCallbacks[xhr.resource.uri].length) {
            this.fetchCallbacks[xhr.resource.uri].shift()(false, "Fetch of <" + xhr.resource.uri + "> failed: "+status, xhr);
        }
        delete this.fetchCallbacks[xhr.resource.uri];
        this.fireCallbacks('fail', [xhr.requestedURI, status])
        xhr.abort()
        return xhr
    }

    // in the why part of the quad distinguish between HTML and HTTP header
    // Reverse is set iif the link was rev= as opposed to rel=
    this.linkData = function(xhr, rel, uri, why, reverse) {
        var x = xhr.resource;
        if (!uri) return;
        var predicate;
        // See http://www.w3.org/TR/powder-dr/#httplink for describedby 2008-12-10
        var obj = kb.sym($rdf.uri.join(uri, xhr.resource.uri));
        if (rel == 'alternate' || rel == 'seeAlso' || rel == 'meta' || rel == 'describedby') {
            if (obj.uri === xhr.resource.uri) return;
            predicate = ns.rdfs('seeAlso');
        } else {
        // See https://www.iana.org/assignments/link-relations/link-relations.xml
        // Alas not yet in RDF yet for each predicate
            predicate = kb.sym($rdf.uri.join(rel, 'http://www.iana.org/assignments/link-relations/'));
        }
        if (reverse) {
            kb.add(obj, predicate, xhr.resource, why);
        } else {
            kb.add(xhr.resource, predicate, obj, why);
        }
    };

    this.parseLinkHeader = function(xhr, thisReq) {
        var link;
        try {
            link = xhr.getResponseHeader('link'); // May crash from CORS error
        }catch(e){}
        if (link) {
            var linkexp = /<[^>]*>\s*(\s*;\s*[^\(\)<>@,;:"\/\[\]\?={} \t]+=(([^\(\)<>@,;:"\/\[\]\?={} \t]+)|("[^"]*")))*(,|$)/g;
            var paramexp = /[^\(\)<>@,;:"\/\[\]\?={} \t]+=(([^\(\)<>@,;:"\/\[\]\?={} \t]+)|("[^"]*"))/g;

            var matches = link.match(linkexp);
            var rels = {};
            for (var i = 0; i < matches.length; i++) {
                var split = matches[i].split('>');
                var href = split[0].substring(1);
                var ps = split[1];
                var s = ps.match(paramexp);
                for (var j = 0; j < s.length; j++) {
                    var p = s[j];
                    var paramsplit = p.split('=');
                    var name = paramsplit[0];
                    var rel = paramsplit[1].replace(/["']/g, ''); //'"
                    this.linkData(xhr, rel, href, thisReq);
                }
            }
        }
    };



    this.doneFetch = function(xhr, args) {
        this.addStatus(xhr.req, 'Done.')
        // $rdf.log.info("Done with parse, firing 'done' callbacks for " + xhr.resource)
        this.requested[xhr.resource.uri] = 'done'; //Kenny
        while (this.fetchCallbacks[xhr.resource.uri] && this.fetchCallbacks[xhr.resource.uri].length) {
            this.fetchCallbacks[xhr.resource.uri].shift()(true, undefined, xhr);
        }
        delete this.fetchCallbacks[xhr.resource.uri];
        this.fireCallbacks('done', args)
    };


    [$rdf.Fetcher.RDFXMLHandler, $rdf.Fetcher.XHTMLHandler,
     $rdf.Fetcher.XMLHandler, $rdf.Fetcher.HTMLHandler,
     $rdf.Fetcher.TextHandler, $rdf.Fetcher.N3Handler ].map(this.addHandler);



    /** Note two nodes are now smushed
     **
     ** If only one was flagged as looked up, then
     ** the new node is looked up again, which
     ** will make sure all the URIs are dereferenced
     */
    this.nowKnownAs = function(was, now) {
        if (this.lookedUp[was.uri]) {
            if (!this.lookedUp[now.uri]) this.lookUpThing(now, was) //  @@@@  Transfer userCallback
        } else if (this.lookedUp[now.uri]) {
            if (!this.lookedUp[was.uri]) this.lookUpThing(was, now)
        }
    }





    // Looks up something.
    //
    // Looks up all the URIs a things has.
    //
    // Parameters:
    //
    //  term:       canonical term for the thing whose URI is to be dereferenced
    //  rterm:      the resource which refered to this (for tracking bad links)
    //  options:    (old: force paraemter) or dictionary of options:
    //      force:      Load the data even if loaded before
    //  oneDone:   is called as callback(ok, errorbody, xhr) for each one
    //  allDone:   is called as callback(ok, errorbody) for all of them
    // Returns      the number of URIs fetched
    //
    this.lookUpThing = function(term, rterm, options, oneDone, allDone) {
        var uris = kb.uris(term) // Get all URIs
        var success = true;
        var errors = '';
        var outstanding = {}, force;
        if (options === false || options === true) { // Old signature
            force = options;
            options = { force: force };
        } else {
            if (options === undefined) options = {};
            force = !!options.force;
        }

        if (typeof uris !== 'undefined') {
            for (var i = 0; i < uris.length; i++) {
                var u = uris[i];
                outstanding[u] = true;
                this.lookedUp[u] = true;
                var sf = this;

                var requestOne = function requestOne(u1){
                    sf.requestURI($rdf.uri.docpart(u1), rterm, options,
                        function(ok, body, xhr){
                            if (ok) {
                                if (oneDone) oneDone(true, u1);
                            } else {
                                if (oneDone) oneDone(false, body);
                                success = false;
                                errors += body + '\n';
                            };
                            delete outstanding[u];
                            for (x in outstanding) return;
                            if (allDone) allDone(success, errors);
                        }
                    );
                };
                requestOne(u);
            }
        }
        return uris.length
    }


    /*  Ask for a doc to be loaded if necessary then call back
    **
    ** Changed 2013-08-20:  Added (ok, errormessage) params to callback
    **
    ** Calling methods:
    **   nowOrWhenFetched (uri, userCallback)
    **   nowOrWhenFetched (uri, options, userCallback)
    **   nowOrWhenFetched (uri, referringTerm, userCallback, options)  <-- old
    **   nowOrWhenFetched (uri, referringTerm, userCallback) <-- old
    **
    **  Options include:
    **   referringTerm    The docuemnt in which this link was found.
    **                    this is valuable when finding the source of bad URIs
    **   force            boolean.  Never mind whether you have tried before,
    **                    load this from scratch.
    **   forceContentType Override the incoming header to force the data to be
    **                    treaed as this content-type.
    **/
    this.nowOrWhenFetched = function(uri, p2, userCallback, options) {
        uri = uri.uri || uri; // allow symbol object or string to be passed
        if (typeof p2 == 'function') {
            options = {};
            userCallback = p2;
        } else if (typeof p2 == 'undefined') { // original calling signature
            referingTerm = undefined;
        } else if (p2 instanceof $rdf.Symbol) {
            referingTerm = p2;
        } else {
            options = p2;
        }

        this.requestURI(uri, p2, options || {}, userCallback);
    }

    this.get = this.nowOrWhenFetched;

    // Look up response header
    //
    // Returns: a list of header values found in a stored HTTP response
    //      or [] if response was found but no header found
    //      or undefined if no response is available.
    //
    this.getHeader = function(doc, header) {
        var kb = this.store;
        var requests = kb.each(undefined, ns.link("requestedURI"), doc.uri);
        for (var r=0; r<requests.length; r++) {
            var request = requests[r];
            if (request !== undefined) {
                var response = kb.any(request, ns.link("response"));
                if (request !== undefined) {
                    var results = kb.each(response, ns.httph(header.toLowerCase()));
                    if (results.length) {
                        return results.map(function(v){return v.value});
                    }
                    return [];
                }
            }
        }
        return undefined;
    };

    this.proxyIfNecessary = function(uri) {
        if (typeof tabulator != 'undefined' && tabulator.isExtension) return uri; // Extenstion does not need proxy
            // browser does 2014 on as https browser script not trusted
            // If the web app origin is https: then the mixed content rules
            // prevent it loading insecure http: stuff so we need proxy.
        if ($rdf.Fetcher.crossSiteProxyTemplate && (typeof document !== 'undefined') &&document.location
			&& ('' + document.location).slice(0,6) === 'https:' // Origin is secure
                && uri.slice(0,5) === 'http:') { // requested data is not
              return $rdf.Fetcher.crossSiteProxyTemplate.replace('{uri}', encodeURIComponent(uri));
        }
        return uri;
    };


    this.saveRequestMetadata = function(xhr, kb, docuri) {
        var request = kb.bnode();
        xhr.resource = $rdf.sym(docuri);

        xhr.req = request;
        if (!xhr.options.noMeta) { // Store no triples but do mind the bnode for req
            var now = new Date();
            var timeNow = "[" + now.getHours() + ":" + now.getMinutes() + ":" + now.getSeconds() + "] ";
            kb.add(request, ns.rdfs("label"), kb.literal(timeNow + ' Request for ' + docuri), this.appNode);
            kb.add(request, ns.link("requestedURI"), kb.literal(docuri), this.appNode);

            kb.add(request, ns.link('status'), kb.collection(), this.appNode);
        }
        return request;
    };

    this.saveResponseMetadata = function(xhr, kb) {
        var response = kb.bnode();

        if (xhr.req) kb.add(xhr.req, ns.link('response'), response);
        kb.add(response, ns.http('status'), kb.literal(xhr.status), response);
        kb.add(response, ns.http('statusText'), kb.literal(xhr.statusText), response);

        xhr.headers = {}
        if ($rdf.uri.protocol(xhr.resource.uri) == 'http' || $rdf.uri.protocol(xhr.resource.uri) == 'https') {
            xhr.headers = $rdf.Util.getHTTPHeaders(xhr)
            for (var h in xhr.headers) { // trim below for Safari - adds a CR!
                kb.add(response, ns.httph(h.toLowerCase()), xhr.headers[h].trim(), response)
            }
        }
        return response;
    };


    /** Requests a document URI and arranges to load the document.
     ** Parameters:
     **	    term:  term for the thing whose URI is to be dereferenced
     **      rterm:  the resource which refered to this (for tracking bad links)
     **      options:
     **              force:  Load the data even if loaded before
     **              withCredentials:   flag for XHR/CORS etc
     **      userCallback:  Called with (true) or (false, errorbody, {status: 400}) after load is done or failed
     ** Return value:
     **	    The xhr object for the HTTP access
     **      null if the protocol is not a look-up protocol,
     **              or URI has already been loaded
     */
    this.requestURI = function(docuri, rterm, options, userCallback) { //sources_request_new
        docuri = docuri.uri || docuri; // Symbol or string
        // Remove #localid
        docuri = docuri.split('#')[0];

        if (typeof options === 'boolean') options = { 'force': options}; // Ols dignature
        if (typeof options === 'undefined') options = {};
        var force = !! options.force
        var kb = this.store;
        var args = arguments;


        var pcol = $rdf.uri.protocol(docuri);
        if (pcol == 'tel' || pcol == 'mailto' || pcol == 'urn') {
            return userCallback? userCallback(false, "Unsupported protocol", {'status':  900 }) : undefined; //"No look-up operation on these, but they are not errors?"
        }
        var docterm = kb.sym(docuri);

        var sta = this.getState(docuri);
        if (!force) {
            if (sta == 'fetched') return userCallback ? userCallback(true) : undefined;
            if (sta == 'failed') return userCallback ?
                userCallback(false, "Previously failed. " + this.requested[docuri],
                    {'status': this.requested[docuri]}) : undefined; // An xhr standin
            //if (sta == 'requested') return userCallback? userCallback(false, "Sorry already requested - pending already.", {'status': 999 }) : undefined;
        } else {
            delete this.nonexistant[docuri];
        }
        // @@ Should allow concurrent requests

        // If it is 'failed', then shoulkd we try again?  I think so so an old error doens't get stuck
        //if (sta == 'unrequested')



        this.fireCallbacks('request', args); //Kenny: fire 'request' callbacks here
        // dump( "web.js: Requesting uri: " + docuri + "\n" );


        if (userCallback) {
            if (!this.fetchCallbacks[docuri]) {
                this.fetchCallbacks[docuri] = [ userCallback ];
            } else {
                this.fetchCallbacks[docuri].push(userCallback);
            }
        }

        if (this.requested[docuri] === true) {
            return; // Don't ask again - wait for existing call
        } else {
            this.requested[docuri] = true;
        }


        if (!options.noMeta && rterm && rterm.uri) {
            kb.add(docterm.uri, ns.link("requestedBy"), rterm.uri, this.appNode)
        }

        var useJQuery = typeof jQuery != 'undefined';
        if (!useJQuery) {
            var xhr = $rdf.Util.XMLHTTPFactory();
            var req = xhr.req = kb.bnode();
            xhr.options = options;
            xhr.resource = docterm;
            xhr.requestedURI = args[0];
        } else {
            var req = kb.bnode();
        }
        var requestHandlers = kb.collection();
        var sf = this;

        var now = new Date();
        var timeNow = "[" + now.getHours() + ":" + now.getMinutes() + ":" + now.getSeconds() + "] ";
        if (!options.noMeta) {
            kb.add(req, ns.rdfs("label"), kb.literal(timeNow + ' Request for ' + docuri), this.appNode)
            kb.add(req, ns.link("requestedURI"), kb.literal(docuri), this.appNode)
            kb.add(req, ns.link('status'), kb.collection(), this.appNode)
        }
        // This should not be stored in the store, but in the JS data
        /*
        if (typeof kb.anyStatementMatching(this.appNode, ns.link("protocol"), $rdf.uri.protocol(docuri)) == "undefined") {
            // update the status before we break out
            this.failFetch(xhr, "Unsupported protocol: "+$rdf.uri.protocol(docuri))
            return xhr
        }
        */
        var checkCredentialsRetry = function() {
            if (!xhr.withCredentials) return false; // not dealt with
            
            console.log("@@ Retrying with no credentials for " + xhr.resource)
            xhr.abort();
            delete sf.requested[docuri]; // forget the original request happened
            newopt = {};
            for (opt in options) if (options.hasOwnProperty(opt)) {
                newopt[opt] = options[opt]
            }
            newopt.withCredentials = false;
            sf.addStatus(xhr.req, "Abort: Will retry with credentials SUPPRESSED to see if that helps");
            sf.requestURI(docuri, rterm, newopt, xhr.userCallback); // usercallback already registered (with where?)
            return true;
        }


        var onerrorFactory = function(xhr) {
            return function(event) {
                xhr.onErrorWasCalled = true; // debugging and may need it
                if  (typeof document !== 'undefined') { // Mashup situation, not node etc
                    if ($rdf.Fetcher.crossSiteProxyTemplate && document.location && !xhr.proxyUsed) { 
                        var hostpart = $rdf.uri.hostpart;
                        var here = '' + document.location;
                        var uri = xhr.resource.uri
                        if (hostpart(here) && hostpart(uri) && hostpart(here) != hostpart(uri)) {
                            if (xhr.status === 401 || xhr.status === 403 || xhr.status === 404) {
                                onreadystatechangeFactory(xhr)();
                            } else {
                                newURI = $rdf.Fetcher.crossSiteProxy(uri);
                                sf.addStatus(xhr.req, "BLOCKED -> Cross-site Proxy to <" + newURI + ">");
                                if (xhr.aborted) return;

                                var kb = sf.store;
                                var oldreq = xhr.req;
                                if (!xhr.options.noMeta) {
                                    kb.add(oldreq, ns.http('redirectedTo'), kb.sym(newURI), oldreq);
                                }
                                xhr.abort()
                                xhr.aborted = true

                                sf.addStatus(oldreq, 'redirected to new request') // why
                                //the callback throws an exception when called from xhr.onerror (so removed)
                                //sf.fireCallbacks('done', args) // Are these args right? @@@   Not done yet! done means success
                                sf.requested[xhr.resource.uri] = 'redirected';

                                if (sf.fetchCallbacks[xhr.resource.uri]) {
                                    if (!sf.fetchCallbacks[newURI]) {
                                        sf.fetchCallbacks[newURI] = [];
                                    }
                                    sf.fetchCallbacks[newURI] == sf.fetchCallbacks[newURI].concat(sf.fetchCallbacks[xhr.resource.uri]);
                                    delete sf.fetchCallbacks[xhr.resource.uri];
                                }

                                var xhr2 = sf.requestURI(newURI, xhr.resource, options);
                                if (xhr2) {
                                    xhr2.proxyUsed = true; //only try the proxy once
                                }
                                if (xhr2 && xhr2.req) {
                                    if (!xhr.options.noMeta) {
                                        kb.add(xhr.req,
                                            kb.sym('http://www.w3.org/2007/ont/link#redirectedRequest'),
                                            xhr2.req,
                                            sf.appNode);
                                    }
                                    return;
                                }
                            }
                        }
                        
                        if (checkCredentialsRetry(xhr)) {
                            return;
                        }
                        xhr.status = 999; // 
                    }
                }; // mashu
            } // function of event
        }; // onerrorFactory

            // Set up callbacks
        var onreadystatechangeFactory = function(xhr) {
            return function() {
                var handleResponse = function() {
                    if (xhr.handleResponseDone) return;
                    xhr.handleResponseDone = true;
                    var handler = null;
                    var thisReq = xhr.req // Might have changes by redirect
                    sf.fireCallbacks('recv', args)
                    var kb = sf.store;
                    var response = sf.saveResponseMetadata(xhr, kb);
                    sf.fireCallbacks('headers', [{uri: docuri, headers: xhr.headers}]);

                    // Check for masked errors.
                    // For "security reasons" theboraser hides errors such as CORS errors from 
                    // the calling code (2015). oneror() used to be called but is not now.
                    // 
                    if (xhr.status === 0) {
                        console.log("Masked error - status 0 for " + xhr.resource.uri);
                        if (checkCredentialsRetry(xhr)) { // retry is could be credentials flag CORS issue
                            return;
                        }
                        xhr.status = 900; // unknown masked error
                        return;
                    }
                    if (xhr.status >= 400) { // For extra dignostics, keep the reply
                    //  @@@ 401 should cause  a retry with credential son
                    // @@@ cache the credentials flag by host ????
                        if (xhr.status === 404) {
                            kb.fetcher.nonexistant[xhr.resource.uri] = true;
                        }
                        if (xhr.responseText.length > 10) {
                            var response = kb.bnode();
                            kb.add(response, ns.http('content'), kb.literal(xhr.responseText), response);
                            if (xhr.statusText) {
                                kb.add(response, ns.http('statusText'), kb.literal(xhr.statusText), response);
                            }
                            // dump("HTTP >= 400 responseText:\n"+xhr.responseText+"\n"); // @@@@
                        }
                        sf.failFetch(xhr, "HTTP error for " +xhr.resource + ": "+ xhr.status + ' ' + xhr.statusText);
                        return;
                    }

                    var loc = xhr.headers['content-location'];

                    // deduce some things from the HTTP transaction
                    var addType = function(cla) { // add type to all redirected resources too
                        var prev = thisReq;
                        if (loc) {
                            var docURI = kb.any(prev, ns.link('requestedURI'));
                            if (docURI != loc) {
                                kb.add(kb.sym(loc), ns.rdf('type'), cla, sf.appNode);
                            }
                        }
                        for (;;) {
                            var doc = kb.any(prev, ns.link('requestedURI'));
                            if (doc && doc.value) // convert Literal
                                kb.add(kb.sym(doc.value), ns.rdf('type'), cla, sf.appNode);
                            prev = kb.any(undefined, kb.sym('http://www.w3.org/2007/ont/link#redirectedRequest'), prev);
                            if (!prev) break;
                            var response = kb.any(prev, kb.sym('http://www.w3.org/2007/ont/link#response'));
                            if (!response) break;
                            var redirection = kb.any(response, kb.sym('http://www.w3.org/2007/ont/http#status'));
                            if (!redirection) break;
                            if (redirection != '301' && redirection != '302') break;
                        }
                    }
                    // This is a minimal set to allow the use of damaged servers if necessary
                    var extensionToContentType = {
                        'rdf': 'application/rdf+xml', 'owl': 'application/rdf+xml',
                        'n3': 'text/n3', 'ttl': 'text/turtle', 'nt': 'text/n3', 'acl': 'text/n3',
                        'html': 'text/html', 'html': 'text/htm',
                        'xml': 'text/xml'
                    };

                    if (xhr.status == 200) {
                        addType(ns.link('Document'));
                        var ct = xhr.headers['content-type'];
                        if (options.forceContentType) {
                            xhr.headers['content-type'] = options.forceContentType;
                        };
                        if (!ct || ct.indexOf('application/octet-stream') >=0 ) {
                            var guess = extensionToContentType[xhr.resource.uri.split('.').pop()];
                            if (guess) {
                                xhr.headers['content-type'] = guess;
                            }
                        }
                        if (ct) {
                            if (ct.indexOf('image/') == 0 || ct.indexOf('application/pdf') == 0) addType(kb.sym('http://purl.org/dc/terms/Image'));
                        }
                        if (options.clearPreviousData) { // Before we parse new data clear old but only on 200
                            kb.removeDocument(xhr.resource);
                        };
                        
                    }
                    // application/octet-stream; charset=utf-8



                    if ($rdf.uri.protocol(xhr.resource.uri) == 'file' || $rdf.uri.protocol(xhr.resource.uri) == 'chrome') {
                        if (options.forceContentType) {
                            xhr.headers['content-type'] = options.forceContentType;
                        } else {
                            var guess = extensionToContentType[xhr.resource.uri.split('.').pop()];
                            if (guess) {
                                xhr.headers['content-type'] = guess;
                            } else {
                                xhr.headers['content-type'] = 'text/xml';
                            }
                        }
                    }

                    // If we have alread got the thing at this location, abort
                    if (loc) {
                        var udoc = $rdf.uri.join(xhr.resource.uri, loc)
                        if (!force && udoc != xhr.resource.uri && sf.requested[udoc]
                            && sf.requested[udoc] == 'done') { // we have already fetched this in fact.
                            // should we smush too?
                            // $rdf.log.info("HTTP headers indicate we have already" + " retrieved " + xhr.resource + " as " + udoc + ". Aborting.")
                            sf.doneFetch(xhr, args)
                            xhr.abort()
                            return
                        }
                        sf.requested[udoc] = true
                    }

                    for (var x = 0; x < sf.handlers.length; x++) {
                        if (xhr.headers['content-type'] && xhr.headers['content-type'].match(sf.handlers[x].pattern)) {
                            handler = new sf.handlers[x]();
                            requestHandlers.append(sf.handlers[x].term) // FYI
                            break
                        }
                    }

                    sf.parseLinkHeader(xhr, thisReq);

                    if (handler) {
                        try {
                            handler.handlerFactory(xhr);
                        } catch(e) { // Try to avoid silent errors
                            sf.failFetch(xhr, "Exception handling content-type " + xhr.headers['content-type'] + ' was: '+e);
                        };
                    } else {
                        sf.doneFetch(xhr, args); //  Not a problem, we just don't extract data.
                        /*
                        // sf.failFetch(xhr, "Unhandled content type: " + xhr.headers['content-type']+
                        //        ", readyState = "+xhr.readyState);
                        */
                        return;
                    }
                };

                // DONE: 4
                // HEADERS_RECEIVED: 2
                // LOADING: 3
                // OPENED: 1
                // UNSENT: 0

                // $rdf.log.debug("web.js: XHR " + xhr.resource.uri + ' readyState='+xhr.readyState); // @@@@ comment me out

                switch (xhr.readyState) {
                case 0:
                    var uri = xhr.resource.uri, newURI;
                    if (this.crossSiteProxyTemplate && (typeof document !== 'undefined') &&document.location) { // In mashup situation
                        var hostpart = $rdf.uri.hostpart;
                        var here = '' + document.location;
                        if (hostpart(here) && hostpart(uri) && hostpart(here) != hostpart(uri)) {
                            newURI = this.crossSiteProxyTemplate.replace('{uri}', encodeURIComponent(uri));
                            sf.addStatus(xhr.req, "BLOCKED -> Cross-site Proxy to <" + newURI + ">");
                            if (xhr.aborted) return;

                            var kb = sf.store;
                            var oldreq = xhr.req;
                            kb.add(oldreq, ns.http('redirectedTo'), kb.sym(newURI), oldreq);


                            ////////////// Change the request node to a new one:  @@@@@@@@@@@@ Duplicate?
                            var newreq = xhr.req = kb.bnode() // Make NEW reqest for everything else
                            kb.add(oldreq, ns.http('redirectedRequest'), newreq, xhr.req);

                            var now = new Date();
                            var timeNow = "[" + now.getHours() + ":" + now.getMinutes() + ":" + now.getSeconds() + "] ";
                            kb.add(newreq, ns.rdfs("label"), kb.literal(timeNow + ' Request for ' + newURI), this.appNode)
                            kb.add(newreq, ns.link('status'), kb.collection(), this.appNode);
                            kb.add(newreq, ns.link("requestedURI"), kb.literal(newURI), this.appNode);

                            var response = kb.bnode();
                            kb.add(oldreq, ns.link('response'), response);
                            // kb.add(response, ns.http('status'), kb.literal(xhr.status), response);
                            // if (xhr.statusText) kb.add(response, ns.http('statusText'), kb.literal(xhr.statusText), response)

                            xhr.abort()
                            xhr.aborted = true;
                            xhr.redirected = true;

                            sf.addStatus(oldreq, 'redirected XHR') // why

                            if (sf.fetchCallbacks[xhr.resource.uri]) {
                                if (!sf.fetchCallbacks[newURI]) {
                                    sf.fetchCallbacks[newURI] = [];
                                }
                                sf.fetchCallbacks[newURI] == sf.fetchCallbacks[newURI].concat(sf.fetchCallbacks[xhr.resource.uri]);
                                delete sf.fetchCallbacks[xhr.resource.uri];
                            }


                            sf.fireCallbacks('redirected', args) // Are these args right? @@@
                            sf.requested[xhr.resource.uri] = 'redirected';

                            var xhr2 = sf.requestURI(newURI, xhr.resource, xhr.options || {} );
                            if (xhr2 && xhr2.req) kb.add(xhr.req,
                                kb.sym('http://www.w3.org/2007/ont/link#redirectedRequest'),
                                xhr2.req, sf.appNode);                             return;
                        }
                    }
                    sf.failFetch(xhr, "HTTP Blocked. (ReadyState 0) Cross-site violation for <"+
                    docuri+">");

                    break;

                case 3:
                    // Intermediate state -- 3 may OR MAY NOT be called, selon browser.
                    // handleResponse();   // In general it you can't do it yet as the headers are in but not the data
                    break
                case 4:
                    // Final state for this XHR but may be redirected
                    handleResponse();
                    // Now handle
                    if (xhr.handle && xhr.responseText) {
                        if (sf.requested[xhr.resource.uri] === 'redirected') {
                            break;
                        }
                        sf.fireCallbacks('load', args)
                        xhr.handle(function() {
                            sf.doneFetch(xhr, args)
                        })
                    } else {
                        if (xhr.redirected) {
                            sf.addStatus(xhr.req, "Aborted and redirected to new request.");
                        } else {
                            sf.addStatus(xhr.req, "Fetch over. No data handled. Aborted = " + xhr.aborted);
                        }
                        // sf.failFetch(xhr, "HTTP failed unusually. (no handler set) (x-site violation? no net?) for <"+
                        //    docuri+">");
                    }
                    break
                } // switch
            };
        }


        // Map the URI to a localhost proxy if we are running on localhost
        // This is used for working offline, e.g. on planes.
        // Is the script istelf is running in localhost, then access all data in a localhost mirror.
        // Do not remove without checking with TimBL
        var uri2 = docuri;
        if (typeof tabulator != 'undefined' && tabulator.preferences.get('offlineModeUsingLocalhost')) {
            if (uri2.slice(0,7) == 'http://'  && uri2.slice(7,17) != 'localhost/') {
                uri2 = 'http://localhost/' + uri2.slice(7);
                $rdf.log.warn("Localhost kludge for offline use: actually getting <" + uri2 + ">");
            } else {
                // $rdf.log.warn("Localhost kludge NOT USED <" + uri2 + ">");
            };
        } else {
            // $rdf.log.warn("Localhost kludge OFF offline use: actually getting <" + uri2 + ">");
        }
        // 2014 probelm:
        // XMLHttpRequest cannot load http://www.w3.org/People/Berners-Lee/card.
        // A wildcard '*' cannot be used in the 'Access-Control-Allow-Origin' header when the credentials flag is true.
        // @ Many ontology files under http: and need CORS wildcard -> can't have withCredentials

        var withCredentials = ( uri2.slice(0,6) === 'https:'); // @@ Kludge -- need for webid which typically is served from https
        if (options.withCredentials !== undefined) {
            withCredentials = options.withCredentials;
        }
        var actualProxyURI = this.proxyIfNecessary(uri2);


        // Setup the request
        if (typeof jQuery !== 'undefined' && jQuery.ajax) {
            var xhrFields = { withCredentials: withCredentials};
            var xhr = jQuery.ajax({
                url: actualProxyURI,
                accepts: {'*': 'text/turtle,text/n3,application/rdf+xml'},
                processData: false,
                xhrFields: xhrFields,
                timeout: sf.timeout,
                headers: force ? { 'cache-control': 'no-cache'} : {},
                error: function(xhr, s, e) {

                    xhr.req = req;   // Add these in case fails before .ajax returns
                    xhr.resource = docterm;
                    xhr.options = options;
                    xhr.requestedURI = uri2;
                    xhr.withCredentials = withCredentials; // Somehow gets lost by jq


                    if (s == 'timeout')
                        sf.failFetch(xhr, "requestTimeout");
                    else
                        onerrorFactory(xhr)(e);
                },
                success: function(d, s, xhr) {

                    xhr.req = req;
                    xhr.resource = docterm;
                    xhr.resource = docterm;
                    xhr.requestedURI = uri2;

                    onreadystatechangeFactory(xhr)();
                }
            });

            xhr.req = req;
            xhr.options = options;

            xhr.resource = docterm;
            xhr.options = options;
            xhr.requestedURI = uri2;
            xhr.actualProxyURI = actualProxyURI;


        } else {
            var xhr = $rdf.Util.XMLHTTPFactory();
            xhr.onerror = onerrorFactory(xhr);
            xhr.onreadystatechange = onreadystatechangeFactory(xhr);
            xhr.timeout = sf.timeout;
            xhr.withCredentials = withCredentials;
            xhr.actualProxyURI = actualProxyURI;

            xhr.req = req;
            xhr.options = options;
            xhr.options = options;
            xhr.resource = docterm;
            xhr.requestedURI = uri2;

            xhr.ontimeout = function () {
                sf.failFetch(xhr, "requestTimeout");
            }
            try {
                xhr.open('GET', actualProxyURI, this.async);
            } catch (er) {
                return this.failFetch(xhr, "XHR open for GET failed for <"+uri2+">:\n\t" + er);
            }
            if (force) { // must happen after open
                xhr.setRequestHeader('Cache-control', 'no-cache');
            }

        } // if not jQuery

        // Set redirect callback and request headers -- alas Firefox Extension Only

        if (typeof tabulator != 'undefined' && tabulator.isExtension && xhr.channel &&
            ($rdf.uri.protocol(xhr.resource.uri) == 'http' ||
             $rdf.uri.protocol(xhr.resource.uri) == 'https')) {
            try {
                xhr.channel.notificationCallbacks = {
                    getInterface: function(iid) {
                        if (iid.equals(Components.interfaces.nsIChannelEventSink)) {
                            return {

                                onChannelRedirect: function(oldC, newC, flags) {
                                    if (xhr.aborted) return;
                                    var kb = sf.store;
                                    var newURI = newC.URI.spec;
                                    var oldreq = xhr.req;
                                    if (!xhr.options.noMeta) {

                                        sf.addStatus(xhr.req, "Redirected: " + xhr.status + " to <" + newURI + ">");
                                        kb.add(oldreq, ns.http('redirectedTo'), kb.sym(newURI), xhr.req);

                                    ////////////// Change the request node to a new one:  @@@@@@@@@@@@ Duplicate code?
                                        var newreq = xhr.req = kb.bnode() // Make NEW reqest for everything else
                                        kb.add(oldreq, ns.http('redirectedRequest'), newreq, this.appNode);

                                        var now = new Date();
                                        var timeNow = "[" + now.getHours() + ":" + now.getMinutes() + ":" + now.getSeconds() + "] ";
                                        kb.add(newreq, ns.rdfs("label"), kb.literal(timeNow + ' Request for ' + newURI), this.appNode)
                                        kb.add(newreq, ns.link('status'), kb.collection(), this.appNode)
                                        kb.add(newreq, ns.link("requestedURI"), kb.literal(newURI), this.appNode)
                                        ///////////////


                                        //// $rdf.log.info('@@ sources onChannelRedirect'+
                                        //               "Redirected: "+
                                        //               xhr.status + " to <" + newURI + ">"); //@@
                                        var response = kb.bnode();
                                        // kb.add(response, ns.http('location'), newURI, response); Not on this response
                                        kb.add(oldreq, ns.link('response'), response);
                                        kb.add(response, ns.http('status'), kb.literal(xhr.status), response);
                                        if (xhr.statusText) kb.add(response, ns.http('statusText'), kb.literal(xhr.statusText), response)
                                    }
                                    if (xhr.status - 0 != 303) kb.HTTPRedirects[xhr.resource.uri] = newURI; // same document as
                                    if (xhr.status - 0 == 301 && rterm) { // 301 Moved
                                        var badDoc = $rdf.uri.docpart(rterm.uri);
                                        var msg = 'Warning: ' + xhr.resource + ' has moved to <' + newURI + '>.';
                                        if (rterm) {
                                            msg += ' Link in <' + badDoc + ' >should be changed';
                                            kb.add(badDoc, kb.sym('http://www.w3.org/2007/ont/link#warning'), msg, sf.appNode);
                                        }
                                        // dump(msg+"\n");
                                    }
                                    xhr.abort()
                                    xhr.aborted = true

                                    if (sf.fetchCallbacks[xhr.resource.uri]) {
                                        if (!sf.fetchCallbacks[newURI]) {
                                            sf.fetchCallbacks[newURI] = [];
                                        }
                                        sf.fetchCallbacks[newURI] == sf.fetchCallbacks[newURI].concat(sf.fetchCallbacks[xhr.resource.uri]);
                                        delete sf.fetchCallbacks[xhr.resource.uri];
                                    }

                                    sf.addStatus(oldreq, 'redirected') // why
                                    sf.fireCallbacks('redirected', args) // Are these args right? @@@
                                    sf.requested[xhr.resource.uri] = 'redirected';

                                    var hash = newURI.indexOf('#');
                                    if (hash >= 0) {
                                        var msg = ('Warning: ' + xhr.resource + ' HTTP redirects to' + newURI + ' which should not contain a "#" sign');
                                        if (!xhr.options.noMeta) {
                                            kb.add(xhr.resource, kb.sym('http://www.w3.org/2007/ont/link#warning'), msg)
                                        }
                                        newURI = newURI.slice(0, hash);
                                    }
                                    var xhr2 = sf.requestURI(newURI, xhr.resource);
                                    if (xhr2 && xhr2.req && !noMeta) kb.add(xhr.req,
                                        kb.sym('http://www.w3.org/2007/ont/link#redirectedRequest'),
                                        xhr2.req, sf.appNode);

                                    // else dump("No xhr.req available for redirect from "+xhr.resource+" to "+newURI+"\n")
                                },

                                // See https://developer.mozilla.org/en/XPCOM_Interface_Reference/nsIChannelEventSink
                                asyncOnChannelRedirect: function(oldC, newC, flags, callback) {
                                    if (xhr.aborted) return;
                                    var kb = sf.store;
                                    var newURI = newC.URI.spec;
                                    var oldreq = xhr.req;
                                    sf.addStatus(xhr.req, "Redirected: " + xhr.status + " to <" + newURI + ">");
                                    kb.add(oldreq, ns.http('redirectedTo'), kb.sym(newURI), xhr.req);



                                    ////////////// Change the request node to a new one:  @@@@@@@@@@@@ Duplicate?
                                    var newreq = xhr.req = kb.bnode() // Make NEW reqest for everything else
                                    // xhr.resource = docterm
                                    // xhr.requestedURI = args[0]
                                    // var requestHandlers = kb.collection()

                                    // kb.add(kb.sym(newURI), ns.link("request"), req, this.appNode)
                                    kb.add(oldreq, ns.http('redirectedRequest'), newreq, xhr.req);

                                    var now = new Date();
                                    var timeNow = "[" + now.getHours() + ":" + now.getMinutes() + ":" + now.getSeconds() + "] ";
                                    kb.add(newreq, ns.rdfs("label"), kb.literal(timeNow + ' Request for ' + newURI), this.appNode)
                                    kb.add(newreq, ns.link('status'), kb.collection(), this.appNode)
                                    kb.add(newreq, ns.link("requestedURI"), kb.literal(newURI), this.appNode)
                                    ///////////////


                                    //// $rdf.log.info('@@ sources onChannelRedirect'+
                                    //               "Redirected: "+
                                    //               xhr.status + " to <" + newURI + ">"); //@@
                                    var response = kb.bnode();
                                    // kb.add(response, ns.http('location'), newURI, response); Not on this response
                                    kb.add(oldreq, ns.link('response'), response);
                                    kb.add(response, ns.http('status'), kb.literal(xhr.status), response);
                                    if (xhr.statusText) kb.add(response, ns.http('statusText'), kb.literal(xhr.statusText), response)

                                    if (xhr.status - 0 != 303) kb.HTTPRedirects[xhr.resource.uri] = newURI; // same document as
                                    if (xhr.status - 0 == 301 && rterm) { // 301 Moved
                                        var badDoc = $rdf.uri.docpart(rterm.uri);
                                        var msg = 'Warning: ' + xhr.resource + ' has moved to <' + newURI + '>.';
                                        if (rterm) {
                                            msg += ' Link in <' + badDoc + ' >should be changed';
                                            kb.add(badDoc, kb.sym('http://www.w3.org/2007/ont/link#warning'), msg, sf.appNode);
                                        }
                                        // dump(msg+"\n");
                                    }
                                    xhr.abort()
                                    xhr.aborted = true

                                    var hash = newURI.indexOf('#');
                                    if (hash >= 0) {
                                        var msg = ('Warning: ' + xhr.resource + ' HTTP redirects to' + newURI + ' which should not contain a "#" sign');
                                        // dump(msg+"\n");
                                        kb.add(xhr.resource, kb.sym('http://www.w3.org/2007/ont/link#warning'), msg)
                                        newURI = newURI.slice(0, hash);
                                    }

                                    if (sf.fetchCallbacks[xhr.resource.uri]) {
                                        if (!sf.fetchCallbacks[newURI]) {
                                            sf.fetchCallbacks[newURI] = [];
                                        }
                                        sf.fetchCallbacks[newURI] == sf.fetchCallbacks[newURI].concat(sf.fetchCallbacks[xhr.resource.uri]);
                                        delete sf.fetchCallbacks[xhr.resource.uri];
                                    }

                                    sf.requested[xhr.resource.uri] = 'redirected';

                                    var xhr2 = sf.requestURI(newURI, xhr.resource);
                                    if (xhr2 && xhr2.req) kb.add(xhr.req,
                                        kb.sym('http://www.w3.org/2007/ont/link#redirectedRequest'),
                                        xhr2.req, sf.appNode);

                                    // else dump("No xhr.req available for redirect from "+xhr.resource+" to "+newURI+"\n")
                                } // asyncOnChannelRedirect
                            }
                        }
                        return Components.results.NS_NOINTERFACE
                    }
                }
            } catch (err) {
                 return sf.failFetch(xhr,
                    "@@ Couldn't set callback for redirects: " + err);
            } // try

        } // if Firefox extension

        try {
            var acceptstring = ""
            for (var type in this.mediatypes) {
                var attrstring = ""
                if (acceptstring != "") {
                    acceptstring += ", "
                }
                acceptstring += type
                for (var attr in this.mediatypes[type]) {
                    acceptstring += ';' + attr + '=' + this.mediatypes[type][attr]
                }
            }
            xhr.setRequestHeader('Accept', acceptstring)

            //if (requester) { xhr.setRequestHeader('Referer',requester) }
        } catch (err) {
            throw ("Can't set Accept header: " + err)
        }

        // Fire

        if (!useJQuery) {
            try {
                xhr.send(null)
            } catch (er) {
                return this.failFetch(xhr, "XHR send failed:" + er);
            }
            setTimeout(function() {
                    if (xhr.readyState != 4 && sf.isPending(xhr.resource.uri)) {
                        sf.failFetch(xhr, "requestTimeout")
                    }
                },
                this.timeout);
            this.addStatus(xhr.req, "HTTP Request sent.");

        } else {
            this.addStatus(xhr.req, "HTTP Request sent (using jQuery)");
        }

        return xhr

    } // this.requestURI()


    this.objectRefresh = function(term) {
        var uris = kb.uris(term) // Get all URIs
        if (typeof uris != 'undefined') {
            for (var i = 0; i < uris.length; i++) {
                this.refresh(this.store.sym($rdf.uri.docpart(uris[i])));
                //what about rterm?
            }
        }
    }

    // deprecated -- use IndexedFormula.removeDocument(doc)
    this.unload = function(term) {
        this.store.removeMany(undefined, undefined, undefined, term)
        delete this.requested[term.uri]; // So it can be loaded again
    }

    this.refresh = function(term, userCallback) { // sources_refresh
        this.fireCallbacks('refresh', arguments)
        this.requestURI(term.uri, undefined, { force: true, clearPreviousData: true}, userCallback)
    }

    this.retract = function(term) { // sources_retract
        this.store.removeMany(undefined, undefined, undefined, term)
        if (term.uri) {
            delete this.requested[$rdf.uri.docpart(term.uri)]
        }
        this.fireCallbacks('retract', arguments)
    }

    this.getState = function(docuri) {
        if (typeof this.requested[docuri] == "undefined") {
            return "unrequested"
        } else if (this.requested[docuri] === true) {
            return "requested"
        } else if (this.requested[docuri] === 'done') {
            return "fetched"
        } else  { // An non-200 HTTP error status
            return "failed"
        }
    }

    //doing anyStatementMatching is wasting time
    this.isPending = function(docuri) { // sources_pending
        //if it's not pending: false -> flailed 'done' -> done 'redirected' -> redirected
        return this.requested[docuri] === true;
    }

    // var updatesVia = new $rdf.UpdatesVia(this); // Subscribe to headers

    // @@@@@@@@ This is turned off because it causes a websocket to be set up for ANY fetch
    // whether we want to track it ot not. including ontologies loaed though the XSSproxy

}; // End of fetcher

$rdf.fetcher = function(store, timeout, async) { return new $rdf.Fetcher(store, timeout, async) };

// Parse a string and put the result into the graph kb
$rdf.parse = function parse(str, kb, base, contentType, callback) {
    try {
        if (contentType == 'text/n3' || contentType == 'text/turtle') {
            var p = $rdf.N3Parser(kb, kb, base, base, null, null, "", null)
            p.loadBuf(str)
            executeCallback();
        } else if (contentType == 'application/rdf+xml') {
            var parser = new $rdf.RDFParser(kb);
            parser.parse($rdf.Util.parseXML(str), base, kb.sym(base));
            executeCallback();
        } else if (contentType == 'application/rdfa') {  // @@ not really a valid mime type
            $rdf.parseDOM_RDFa($rdf.Util.parseXML(str), kb, base);
            executeCallback();
        } else if (contentType == 'application/sparql-update') {  // @@ we handle a subset
            spaqlUpdateParser(store, str, base)
            executeCallback();
        } else if (contentType == 'application/ld+json' ||
            contentType == 'application/nquads' ||
            contentType == 'application/n-quads') {
            var n3Parser = N3.Parser();
            var N3Util = N3.Util;
            var triples = []
            var prefixes = {};
            if (contentType == 'application/ld+json') {
                var jsonDocument;
                try {
                    jsonDocument = JSON.parse(str);
                    setJsonLdBase(jsonDocument, base);
                } catch(parseErr) {
                    callback(err, null);
                }
                jsonld.toRDF(jsonDocument,
                    {format: 'application/nquads'},
                    nquadCallback);
            } else {
                nquadCallback(null, str);
            }
        } else {
            throw "Don't know how to parse "+contentType+" yet";
        }
    } catch(e) {
        executeErrorCallback(e);
    }

    function executeCallback() {
        if (callback) {
            callback(null, kb);
        } else {
            return;
        }
    }

    function executeErrorCallback(e) {
        if(contentType != 'application/ld+json' ||
           contentType != 'application/nquads' ||
           contentType != 'application/n-quads') {
            if (callback) {
                callback(e, kb);
            } else {
                throw "Error trying to parse <"+base+"> as " +
                    contentType+":\n"+e +':\n'+e.stack;
            }
        }
    }

    function setJsonLdBase(doc, base) {
        if (doc instanceof Array) {
            return;
        }
        if (!('@context' in doc)) {
            doc['@context'] = {};
        }
        doc['@context']['@base'] = base;
    }

    function nquadCallback(err, nquads) {
        if (err) {
            callback(err, kb);
        }
        try {
            n3Parser.parse(nquads, tripleCallback);
        } catch (err) {
            callback(err, kb);
        }
    }

    function tripleCallback(err, triple, prefixes) {
        if (err) {
            callback(err, kb);
        }
        if (triple) {
            triples.push(triple);
        } else {
            for (var i = 0; i < triples.length; i++) {
                addTriple(kb, triples[i]);
            }
            callback(null, kb);
        }
    }

    function addTriple(kb, triple) {
        var subject = createTerm(triple.subject);
        var predicate = createTerm(triple.predicate);
        var object = createTerm(triple.object);
        var why = null;
        if (triple.graph) {
            why = createTerm(triple.graph);
        }
        kb.add(subject, predicate, object, why);
    }

    function createTerm(termString) {
        if (N3Util.isLiteral(termString)) {
            var value = N3Util.getLiteralValue(termString);
            var language = N3Util.getLiteralLanguage(termString);
            var datatype = new $rdf.Symbol(N3Util.getLiteralType(termString));
            return new $rdf.Literal(value, language, datatype);
        } else if (N3Util.isIRI(termString)) {
            return new $rdf.Symbol(termString);
        } else if (N3Util.isBlank(termString)) {
            var value = termString.substring(2, termString.length);
            return new $rdf.BlankNode(value);
        } else {
            return null;
        }
    }
}; // $rdf.parse()


//   Serialize to the appropriate format
//
// Either
//
// @@ Currently NQuads and JSON/LD are deal with extrelemently inefficiently
// through mutiple conversions.
//
$rdf.serialize = function(target, kb, base, contentType, callback) {
    var documentString = null;
    try {
        var sz = $rdf.Serializer(kb);
        var newSts = kb.statementsMatching(undefined, undefined, undefined, target);
        var n3String;
        sz.suggestNamespaces(kb.namespaces);
        sz.setBase(base);
        switch(contentType){
        case 'application/rdf+xml':
            documentString = sz.statementsToXML(newSts);
            return executeCallback(null, documentString);
            break;
        case 'text/n3':
        case 'text/turtle':
        case 'application/x-turtle': // Legacy
        case 'application/n3': // Legacy
            documentString = sz.statementsToN3(newSts);
            return executeCallback(null, documentString);
        case 'application/ld+json':
            n3String = sz.statementsToN3(newSts);
            $rdf.convert.convertToJson(n3String, callback);
            break;
        case 'application/n-quads':
        case 'application/nquads': // @@@ just outpout the quads? Does not work for collections
            n3String = sz.statementsToN3(newSts);
            documentString = $rdf.convert.convertToNQuads(n3String, callback);
            break;
        default:
            throw "Serialize: Content-type "+ contentType +" not supported for data write.";
        }
    } catch(err) {
        if (callback) {
            return (err);
        }
        throw err; // Don't hide problems from caller in sync mode
    }

    function executeCallback(err, result) {
        if(callback) {
            callback(err, result);
            return;
        } else {
            return result;
        }
    }
};

////////////////// JSON-LD code currently requires Node
//
//  Beware of bloat of the library! timbl
//


if (typeof $rdf.convert == 'undefined') $rdf.convert = {};

$rdf.convert.convertToJson = function(n3String, jsonCallback) {
    var jsonString = undefined;
    var n3Parser = N3.Parser();
    var n3Writer = N3.Writer({
            format: 'N-Quads'
    });
    asyncLib.waterfall([
            function(callback) {
                n3Parser.parse(n3String, callback);
            },
            function(triple, prefix, callback) {
                if (triple !== null) {
                    n3Writer.addTriple(triple);
                }
                if (typeof callback === 'function') {
                    n3Writer.end(callback);
                }
            },
            function(result, callback) {
                try {
                    jsonld.fromRDF(result, {
                            format: 'application/nquads'
                    }, callback);
                } catch (err) {
                    callback(err);
                }
            },
            function(json, callback) {
                jsonString = JSON.stringify(json);
                jsonCallback(null, jsonString);
            }
        ], function(err, result) {
            jsonCallback(err, jsonString);
        }
    );
};

$rdf.convert.convertToNQuads = function(n3String, nquadCallback) {
    var nquadString = undefined;
    var n3Parser = N3.Parser();
    var n3Writer = N3.Writer({
        format: 'N-Quads'
    });
    asyncLib.waterfall([
            function(callback) {
                n3Parser.parse(n3String, callback);
            },
            function(triple, prefix, callback) {
                if (triple !== null) {
                    n3Writer.addTriple(triple);
                }
                if (typeof callback === 'function') {
                    n3Writer.end(callback);
                }
            },
            function(result, callback) {
                nquadString = result;
                nquadCallback(null, nquadString);
            },
        ], function(err, result) {
            nquadCallback(err, nquadString);
            }
    );
};


// ends
