// Matching a formula against another formula
// Assync as well as Synchronously
//
//
// W3C open source licence 2005.
//
// This builds on term.js, match.js (and identity.js?)
// to allow a query of a formula.
//
// Here we introduce for the first time a subclass of term: variable.
//
// SVN ID: $Id: query.js 25116 2008-11-15 16:13:48Z timbl $

//  Variable
//
// Compare with BlankNode.  They are similar, but a variable
// stands for something whose value is to be returned.
// Also, users name variables and want the same name back when stuff is printed

/*jsl:option explicit*/ // Turn on JavaScriptLint variable declaration checking


// The Query object.  Should be very straightforward.
//
// This if for tracking queries the user has in the UI.
//
$rdf.Query = function (name, id) {
    this.pat = new $rdf.IndexedFormula(); // The pattern to search for
    this.vars = []; // Used by UI code but not in query.js
//    this.orderBy = []; // Not used yet
    this.name = name;
    this.id = id;
};

/**The QuerySource object stores a set of listeners and a set of queries.
 * It keeps the listeners aware of those queries that the source currently
 * contains, and it is then up to the listeners to decide what to do with
 * those queries in terms of displays.
 * Not used 2010-08 -- TimBL
 * @constructor
 * @author jambo
 */
$rdf.QuerySource = function() {
    /**stores all of the queries currently held by this source, indexed by ID number.
     */
    this.queries=[];
    /**stores the listeners for a query object.
     * @see TabbedContainer
     */
    this.listeners=[];

    /**add a Query object to the query source--It will be given an ID number
     * and a name, if it doesn't already have one. This subsequently adds the
     * query to all of the listeners the QuerySource knows about.
     */
    this.addQuery = function(q) {
        var i;
        if(q.name === null || q.name === "") {
				    q.name="Query #"+(this.queries.length+1);
        }
        q.id=this.queries.length;
        this.queries.push(q);
        for(i=0; i<this.listeners.length; i++) {
            if(this.listeners[i] !== null) {
                this.listeners[i].addQuery(q);
            }
        }
    };

    /**Remove a Query object from the source.  Tells all listeners to also
     * remove the query.
     */
    this.removeQuery = function(q) {
        var i;
        for(i=0; i<this.listeners.length; i++) {
            if(this.listeners[i] !== null) {
                this.listeners[i].removeQuery(q);
            }
        }
        if(this.queries[q.id] !== null) {
            delete this.queries[q.id];
        }
    };

    /**adds a "Listener" to this QuerySource - that is, an object
     * which is capable of both adding and removing queries.
     * Currently, only the TabbedContainer class is added.
     * also puts all current queries into the listener to be used.
     */
    this.addListener = function(listener) {
        var i;
        this.listeners.push(listener);
        for(i=0; i<this.queries.length; i++) {
            if (this.queries[i] !== null) {
                listener.addQuery(this.queries[i]);
            }
        }
    };
    /**removes listener from the array of listeners, if it exists! Also takes
     * all of the queries from this source out of the listener.
     */
    this.removeListener = function(listener) {
        var i;
        for(i=0; i<this.queries.length; i++) {
            if(this.queries[i] !== null) {
                listener.removeQuery(this.queries[i]);
            }
        }

        for(i=0; i<this.listeners.length; i++) {
            if(this.listeners[i] === listener) {
                delete this.listeners[i];
            }
        } 
    };
};

$rdf.Variable.prototype.isVar = 1;
$rdf.BlankNode.prototype.isVar = 1;
$rdf.BlankNode.prototype.isBlank = 1;
$rdf.Symbol.prototype.isVar = 0;
$rdf.Literal.prototype.isVar = 0;
$rdf.Formula.prototype.isVar = 0;
$rdf.Collection.prototype.isVar = 0;


/**
 * This function will match a pattern to the current kb
 * 
 * The callback function is called whenever a match is found
 * When fetcher is supplied this will be called to satisfy any resource requests 
 * currently not in the kb. The fetcher function needs to be defined manualy and
 * should call $rdf.Util.AJAR_handleNewTerm to process the requested resource. 
 * 
 * @param	myQuery,	a knowledgebase containing a pattern to use as query
 * @param	callback, 	whenever the pattern in myQuery is met this is called with 
 * 						the new bindings as parameter
 * @param	fetcher,	whenever a resource needs to be loaded this gets called  IGNORED OBSOLETE
 *                              f.fetecher is used as a Fetcher instance to do this.
 * @param       onDone          callback when 
 */
$rdf.IndexedFormula.prototype.query = function(myQuery, callback, fetcher, onDone) {
    var kb = this;

    ///////////// Debug strings

    var bindingDebug = function (b) {
            var str = "", v;
            for (v in b) {
               if (b.hasOwnProperty(v)) {
                   str += "    "+v+" -> "+b[v];
                }
            }
            return str;
    };

    var bindingsDebug = function (nbs) {
        var str = "Bindings: ";
        var i, n=nbs.length;
        for (i=0; i<n; i++) {
            str+= bindingDebug(nbs[i][0])+';\n\t';
        }
        return str;
    }; //bindingsDebug


// Unification: see also 
//  http://www.w3.org/2000/10/swap/term.py
// for similar things in python
//
// Unification finds all bindings such that when the binding is applied
// to one term it is equal to the other.
// Returns: a list of bindings, where a binding is an associative array
//  mapping variuable to value.


    var unifyTerm = function (self, other, bindings, formula) {
        var actual = bindings[self];
        if (actual === undefined) { // Not mapped
            if (self.isVar) {
                    /*if (self.isBlank)  //bnodes are existential variables
                    {
                            if (self.toString() == other.toString()) return [[ [], null]];
                            else return [];
                    }*/
                var b = [];
                b[self] = other;
                return [[  b, null ]]; // Match
            }
            actual = self;
        }
        if (!actual.complexType) {
            if (formula.redirections[actual]) {
                actual = formula.redirections[actual];
            }
            if (formula.redirections[other])  {
                other  = formula.redirections[other];
            }
            if (actual.sameTerm(other)) {
                return [[ [], null]];
            }
            return [];
        }
        if (self instanceof Array) {
            if (!(other instanceof Array)) {
                return [];
            }
            return unifyContents(self, other, bindings);
        }
        throw("query.js: oops - code not written yet");
        // return undefined;  // for lint - no jslint objects to unreachables
    //    return actual.unifyContents(other, bindings)
    }; //unifyTerm



    var unifyContents = function (self, other, bindings, formula) {
        var nbs2;
        if (self.length !== other.length) {
            return []; // no way
        }
        if (!self.length) {
            return [[ [], null ]]; // Success
        }
        var nbs = unifyTerm(self[0], other[0], bindings, formula);
        if (nbs.length === 0) {
            return nbs;
        }
        var res = [];
        var i, n = nbs.length, nb, j, m, v, nb2, bindings2;
        for (i=0; i<n; i++) { // for each possibility from the first term
            nb = nbs[i][0]; // new bindings
            bindings2 = [];
            for (v in nb) {
                if (nb.hasOwnProperty(v)) {
                    bindings2[v] = nb[v]; // copy
                }
            }
            for (v in bindings) {
                if (bindings.hasOwnProperty(v)) {
                    bindings2[v] = bindings[v]; // copy
                }
            }
            nbs2 = unifyContents(self.slice(1), other.slice(1), bindings2, formula);
            m = nbs2.length;
            for (j=0; j<m; j++) {
                nb2 = nbs2[j][0];   //@@@@ no idea whether this is used or right
                for (v in nb) {
                    if (nb.hasOwnProperty(v)) {
                        nb2[v] = nb[v];
                    }
                }
                res.push([nb2, null]);
            }
        }
        return res;
    }; // unifyContents





    //  Matching
    //
    // Matching finds all bindings such that when the binding is applied
    // to one term it is equal to the other term.  We only match formulae.

    /** if x is not in the bindings array, return the var; otherwise, return the bindings **/
    var bind = function (x, binding) {
        var y = binding[x];
        if (y === undefined) {
            return x;
        }
        return y;
    };






    // When there are OPTIONAL clauses, we must return bindings without them if none of them
    // succeed. However, if any of them do succeed, we should not.  (This is what branchCount()
    // tracked. The problem currently is (2011/7) that when several optionals exist, and they
    // all match, multiple sets of bindings are returned, each with one optional filled in.)
    
    var union = function(a,b) {
       var c= {};
       var x;
       for (x in a) {
            if (a.hasOwnProperty(x)) {
                c[x] = a[x];
            }
        }
       for (x in b) {
            if (b.hasOwnProperty(x)) {
                c[x] = b[x];
            }
        }
        return c;
    };
    
    var OptionalBranchJunction = function(originalCallback, trunkBindings) {
        this.trunkBindings = trunkBindings;
        this.originalCallback = originalCallback;
        this.branches = [];
        //this.results = []; // result[i] is an array of bindings for branch i
        //this.done = {};  // done[i] means all/any results are in for branch i
        //this.count = {};
        return this;
    };

    OptionalBranchJunction.prototype.checkAllDone = function() {
        var i;
        for (i=0; i<this.branches.length; i++) {
            if (!this.branches[i].done) {
                return;
            }
        }
        $rdf.log.debug("OPTIONAL BIDNINGS ALL DONE:");
        this.doCallBacks(this.branches.length-1, this.trunkBindings);
    
    };
    // Recrursively generate the cross product of the bindings
    OptionalBranchJunction.prototype.doCallBacks = function(b, bindings) {
        var j;
        if (b < 0) {
            return this.originalCallback(bindings); 
        }
        for (j=0; j < this.branches[b].results.length; j++) {
            this.doCallBacks(b-1, union(bindings, this.branches[b].results[j]));
        }
    };
    
    // A mandatory branch is the normal one, where callbacks
    // are made immediately and no junction is needed.
    // Might be useful for onFinsihed callback for query API.
    var MandatoryBranch = function (callback, onDone) {
        this.count = 0;
        this.success = false;
        this.done = false;
        // this.results = [];
        this.callback = callback;
        this.onDone = onDone;
        // this.junction = junction;
        // junction.branches.push(this);
        return this;
    };
    
    MandatoryBranch.prototype.reportMatch = function(bindings) {
        // $rdf.log.error("@@@@ query.js 1"); // @@
        this.callback(bindings);
        this.success = true;
    };

    MandatoryBranch.prototype.reportDone = function() {
        this.done = true;
        $rdf.log.info("Mandatory query branch finished.***");
        if (this.onDone !== undefined) {
            this.onDone();
        }
    };


    // An optional branch hoards its results.
    var OptionalBranch = function (junction) {
        this.count = 0;
        this.done = false;
        this.results = [];
        this.junction = junction;
        junction.branches.push(this);
        return this;
    };
    
    OptionalBranch.prototype.reportMatch = function(bindings) {
        this.results.push(bindings);
    };

    OptionalBranch.prototype.reportDone = function() {
        $rdf.log.debug("Optional branch finished - results.length = "+this.results.length);
        if (this.results.length === 0) {// This is what optional means: if no hits,
            this.results.push({});  // mimic success, but with no bindings
            $rdf.log.debug("Optional branch FAILED - that's OK.");
        }
        this.done = true;
        this.junction.checkAllDone();
    };











    /** prepare -- sets the index of the item to the possible matches
        * @param f - formula
        * @param item - an Statement, possibly w/ vars in it
        * @param bindings - 
    * @returns true if the query fails -- there are no items that match **/
    var prepare = function (f, item, bindings) {
        var t, terms, termIndex, i, ind;
        item.nvars = 0;
        item.index = null;
        // if (!f.statements) $rdf.log.warn("@@@ prepare: f is "+f);
    //    $rdf.log.debug("Prepare: f has "+ f.statements.length);
        //$rdf.log.debug("Prepare: Kb size "+f.statements.length+" Preparing "+item);
        
        terms = [item.subject,item.predicate,item.object];
        ind = [f.subjectIndex,f.predicateIndex,f.objectIndex];
        for (i=0; i<3; i++) {
            //alert("Prepare "+terms[i]+" "+(terms[i] in bindings));
            if (terms[i].isVar && !(bindings[terms[i]] !== undefined)) {
                item.nvars++;
            } else {
                t = bind(terms[i], bindings); //returns the RDF binding if bound, otherwise itself
                //if (terms[i]!=bind(terms[i],bindings) alert("Term: "+terms[i]+"Binding: "+bind(terms[i], bindings));
                if (f.redirections[t.hashString()]) {
                    t = f.redirections[t.hashString()]; //redirect
                }
                termIndex = ind[i][t.hashString()];
                
                if (!termIndex) {
                    item.index = [];
                    return false; // Query line cannot match
                }
                if ((item.index === null) || (item.index.length > termIndex.length)) {
                    item.index = termIndex;
                }
            }
        }
            
        if (item.index === null) { // All 3 are variables? 
            item.index = f.statements;
        }
        return true;
    }; //prepare
        
    /** sorting function -- negative if self is easier **/
    // We always prefer to start with a URI to be able to browse a graph
    // this is why we put off items with more variables till later.
    function easiestQuery(self, other) {
        if (self.nvars !== other.nvars) {
            return self.nvars - other.nvars;
        }
        return self.index.length - other.index.length;
    }

    var match_index = 0; //index
    /** matches a pattern formula against the knowledge base, e.g. to find matches for table-view
    *
    * @param f - knowledge base formula
    * @param g - pattern formula (may have vars)
    * @param bindingsSoFar  - bindings accumulated in matching to date
    * @param level - spaces to indent stuff also lets you know what level of recursion you're at
    * @param fetcher - function (term, requestedBy) - myFetcher / AJAR_handleNewTerm / the sort
    * @param localCallback - function(bindings, pattern, branch) called on sucess
    * @returns nothing 
    *
    * Will fetch linked data from the web iff the knowledge base an associated source fetcher (f.fetcher)
    ***/
    var match = function (f, g, bindingsSoFar, level, fetcher, localCallback, branch) {
        $rdf.log.debug("Match begins, Branch count now: "+branch.count+" for "+branch.pattern_debug);
        var sf = f.fetcher ? f.fetcher : null;
        //$rdf.log.debug("match: f has "+f.statements.length+", g has "+g.statements.length)
        var pattern = g.statements;
        if (pattern.length === 0) { //when it's satisfied all the pattern triples

            $rdf.log.debug("FOUND MATCH WITH BINDINGS:"+bindingDebug(bindingsSoFar));
            if (g.optional.length === 0) {
                branch.reportMatch(bindingsSoFar);
            }
            else {
                $rdf.log.debug("OPTIONAL: "+g.optional);
                var junction = new OptionalBranchJunction(callback, bindingsSoFar); // @@ won't work with nested optionals? nest callbacks
                var br = [], b;
                for (b =0; b < g.optional.length; b++) {
                    br[b] = new OptionalBranch(junction); // Allocate branches to prevent premature ending
                    br[b].pattern_debug = g.optional[b]; // for diagnotics only
                }
                for (b = 0; b < g.optional.length; b++) {
                    br[b].count =  br[b].count + 1;  // Count how many matches we have yet to complete
                    match(f, g.optional[b], bindingsSoFar, '', fetcher, callback, br[b]);
                }
            }
            branch.count--;
            $rdf.log.debug("Match ends -- success , Branch count now: "+branch.count+" for "+branch.pattern_debug);
            return; // Success
        }
        
        var item, i, n=pattern.length;
        //$rdf.log.debug(level + "Match "+n+" left, bs so far:"+bindingDebug(bindingsSoFar))

        // Follow links from variables in query
        if (sf) {   //Fetcher is used to fetch URIs, function first term is a URI term, second is the requester
            var id = "match" + match_index++;
            var fetchResource = function (requestedTerm, id) {
                var docuri = requestedTerm.uri.split("#")[0];
                sf.nowOrWhenFetched(docuri, undefined, function(err, body, xhr) {
                    if (err) {
                        console.log("Error following link to <" + requestedTerm.uri + "> in query: " + body )
                    }
                    match(f, g, bindingsSoFar, level, fetcher, // match not match2 to look up any others necessary.
                        localCallback, branch);
                });
                /*
                if( sf ) {
                    sf.addCallback('done', function(uri) {
                        if ((kb.canon(kb.sym(uri)).uri !== path) && (uri !== kb.canon(kb.sym(path)))) {
                            return true;
                        }
                        return false;
                    });
                }
                fetcher(requestedTerm, id);
                */    
            };
            for (i=0; i<n; i++) {
                item = pattern[i];  //for each of the triples in the query
                if ((bindingsSoFar[item.subject] !== undefined) 
                    && bindingsSoFar[item.subject].uri
                    && sf && sf.getState($rdf.Util.uri.docpart(bindingsSoFar[item.subject].uri)) === "unrequested") {
                    //fetch the subject info and return to id
                    fetchResource(bindingsSoFar[item.subject],id);
                    return; // only look up one per line this time, but we will come back again though match
                }    
                if (bindingsSoFar[item.object] !== undefined
                           && bindingsSoFar[item.object].uri
                           && sf && sf.getState($rdf.Util.uri.docpart(bindingsSoFar[item.object].uri)) === "unrequested") {
                    fetchResource(bindingsSoFar[item.object], id);
                    return;
                }
            }
        } // if sf
        match2(f, g, bindingsSoFar, level, fetcher, localCallback, branch);     
        return;
    }; // match


    var constraintsSatisfied = function (bindings,constraints)
    {
        var res = true, x, test;
        for (x in bindings) {
            if (bindings.hasOwnProperty(x)) {
                if (constraints[x]) {
                    test = constraints[x].test;
                    if (test && !test(bindings[x])) {
                            res=false;
                    }
                }
            }
        }
        return res;
    };



    /** match2 -- stuff after the fetch **/
    var match2 = function (f, g, bindingsSoFar, level, fetcher, callback, branch) { // post fetch
        var pattern = g.statements, n = pattern.length, i,
            k, nk, v, bindings2, newBindings1, item;
        for (i=0; i<n; i++) {  //For each statement left in the query, run prepare
            item = pattern[i];
            $rdf.log.info("match2: item=" + item + ", bindingsSoFar=" + bindingDebug(bindingsSoFar));
            prepare(f, item, bindingsSoFar);
        }
        pattern.sort(easiestQuery);
        item = pattern[0];
        // $rdf.log.debug("Sorted pattern:\n"+pattern)
        var rest = f.formula();
        rest.optional = g.optional;
        rest.constraints = g.constraints;
        rest.statements = pattern.slice(1); // No indexes: we will not query g. 
        $rdf.log.debug(level + "match2 searching "+item.index.length+ " for "+item+
                "; bindings so far="+bindingDebug(bindingsSoFar));
        //var results = [];
        var c, nc=item.index.length, nbs1, st, onward = 0;
        //var x;
        for (c=0; c<nc; c++) {   // For each candidate statement
            st = item.index[c]; //for each statement in the item's index, spawn a new match with that binding 
            nbs1 = unifyContents(
                    [item.subject, item.predicate, item.object],
                    [st.subject, st.predicate, st.object], bindingsSoFar, f);
            $rdf.log.info(level+" From first: "+nbs1.length+": "+bindingsDebug(nbs1));
            nk=nbs1.length;
            //branch.count += nk;
            //$rdf.log.debug("Branch count bumped "+nk+" to: "+branch.count);
            for (k=0; k<nk; k++) {  // For each way that statement binds
                bindings2 = [];
                newBindings1 = nbs1[k][0]; 
                if (!constraintsSatisfied(newBindings1,g.constraints)) {
                    //branch.count--;
                    $rdf.log.debug("Branch count CS: "+branch.count);
                } else {
                    for (v in newBindings1){
                        if (newBindings1.hasOwnProperty(v)) {
                            bindings2[v] = newBindings1[v]; // copy
                        }
                    }
                    for (v in bindingsSoFar) {
                        if (bindingsSoFar.hasOwnProperty(v)) {
                            bindings2[v] = bindingsSoFar[v]; // copy
                        }
                    }
                    
                    branch.count++;  // Count how many matches we have yet to complete
                    onward ++;
                    match(f, rest, bindings2, level+ '  ', fetcher, callback, branch); //call match
                }
            }
        }
        branch.count--;
        if (onward === 0) {
            $rdf.log.debug("Match2 fails completely on " + item);
        }
        $rdf.log.debug("Match2 ends, Branch count: "+branch.count +" for "+branch.pattern_debug);
        if (branch.count === 0) {
            $rdf.log.debug("Branch finished.");
            branch.reportDone();
        }
    }; //match2

    //////////////////////////// Body of query()  ///////////////////////
    /*
    if(!fetcher) {
        fetcher=function (x, requestedBy) {
            if (x === null) {
                return;
            }
            $rdf.Util.AJAR_handleNewTerm(kb, x, requestedBy);
        };
    } 
    */
    //prepare, oncallback: match1
    //match1: fetcher, oncallback: match2
    //match2, oncallback: populatetable
    //    $rdf.log.debug("Query F length"+this.statements.length+" G="+myQuery)
    var f = this;
    $rdf.log.debug("Query on "+this.statements.length);
    
    
    //kb.remoteQuery(myQuery,'http://jena.hpl.hp.com:3040/backstage',callback);
    //return;


    var trunck = new MandatoryBranch(callback, onDone);
    trunck.count++; // count one branch to complete at the moment
    setTimeout(function() { match(f, myQuery.pat, myQuery.pat.initBindings, '', fetcher, callback, trunck /*branch*/ ); }, 0);
    
    return; //returns nothing; callback does the work
}; //query

// ENDS
