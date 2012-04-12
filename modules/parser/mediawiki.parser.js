/**
 * This module assembles parser pipelines from parser stages with
 * asynchronous communnication between stages based on events. Apart from the
 * default pipeline which converts WikiText to HTML DOM, it also provides
 * sub-pipelines for the processing of template transclusions.
 *
 * See http://www.mediawiki.org/wiki/Parsoid and 
 * http://www.mediawiki.org/wiki/Parsoid/Token_stream_transformations
 * for illustrations of the pipeline architecture.
 *
 * @author Gabriel Wicke <gwicke@wikimedia.org>
 * @author Neil Kandalgaonkar <neilk@wikimedia.org>
 */

// make this global for now
// XXX: figure out a way to get away without a global for PEG actions!
$ = require('jquery');
var events = require( 'events' );

var fs = require('fs'),
	path = require('path'),
	PegTokenizer                = require('./mediawiki.tokenizer.peg.js').PegTokenizer,
	TokenTransformManager       = require('./mediawiki.TokenTransformManager.js'),

	NoIncludeOnly				= require('./ext.core.NoIncludeOnly.js'),
	IncludeOnly					= NoIncludeOnly.IncludeOnly,
	NoInclude					= NoIncludeOnly.NoInclude,
	OnlyInclude					= NoIncludeOnly.OnlyInclude,
	QuoteTransformer            = require('./ext.core.QuoteTransformer.js').QuoteTransformer,
	PostExpandParagraphHandler  = require('./ext.core.PostExpandParagraphHandler.js')
																.PostExpandParagraphHandler,
	Sanitizer                   = require('./ext.core.Sanitizer.js').Sanitizer,
	TemplateHandler             = require('./ext.core.TemplateHandler.js').TemplateHandler,
	AttributeExpander            = require('./ext.core.AttributeExpander.js').AttributeExpander,
	LinkHandler                 = require('./ext.core.LinkHandler.js'),
	WikiLinkHandler				= LinkHandler.WikiLinkHandler,
	ExternalLinkHandler			= LinkHandler.ExternalLinkHandler,
	Cite                        = require('./ext.Cite.js').Cite,
	BehaviorSwitchHandler       = require('./ext.core.BehaviorSwitchHandler.js').BehaviorSwitchHandler,
	FauxHTML5                   = require('./mediawiki.HTML5TreeBuilder.node.js').FauxHTML5,
	DOMPostProcessor            = require('./mediawiki.DOMPostProcessor.js').DOMPostProcessor,
	DOMConverter                = require('./mediawiki.DOMConverter.js').DOMConverter,
	ConvertDOMToLM              = require('./mediawiki.LinearModelConverter.js').ConvertDOMToLM;

/**
 * Set up a simple parser pipeline. There will be a single pipeline overall,
 * but there can be multiple sub-pipelines for template expansions etc, which
 * in turn differ by input type. The main input type will be fixed at
 * construction time though.
 *
 * @class
 * @constructor
 * @param {Object} Environment.
 */
function ParserPipeline( env, inputType ) {

	if ( ! inputType ) {
		// Actually the only one supported for now, but could also create
		// others for serialized tokens etc
		inputType = 'text/wiki';
	}
	this.inputType = inputType;


	// Pass in a full-fledged environment based on
	// mediawiki.parser.environment.js.
	if ( !env ) {
		this.env = {};
	} else {
		this.env = env;
	}

	// set up a sub-pipeline cache
	this.pipelineCache = {};
	this.pipelineCache[this.inputType] = { 
		'input-toplevel': [], 
		'input-include': [], 
		'attribute-include': [],
		'attribute-toplevel': [] 
	};

	// Create an input pipeline for the given input type.
	this.inputPipeline = this.makeInputPipeline ( inputType, {}, false );

	// Mark this pipeline as the top-level input pipeline, so that it is not
	// cached and its listeners removed
	this.inputPipeline.atTopLevel = true;
	this.inputPipeline.last.atTopLevel = true;


	this.tokenPostProcessor = new TokenTransformManager
					.SyncTokenTransformManager ( env, inputType, 3.0, false );
	this.tokenPostProcessor.listenForTokensFrom ( this.inputPipeline );


	// Add token transformations..
	this._addTransformers( this.inputType, 'sync23', this.tokenPostProcessor, false );

	/**
	* The tree builder creates a DOM tree from the token soup emitted from
	* the TokenTransformDispatcher.
	*/
	this.treeBuilder = new FauxHTML5.TreeBuilder();
	this.treeBuilder.listenForTokensFrom( this.tokenPostProcessor );
	//this.tokenPostProcessor.on('chunk', function( c ) {
	//	console.warn( JSON.stringify( c, null, 2 ));
	//} );

	/**
	* Final processing on the HTML DOM.
	*/

	/* Generic DOM transformer.
	* This currently performs minor tree-dependent clean up like wrapping
	* plain text in paragraphs. For HTML output, it would also be configured
	* to perform more aggressive nesting cleanup.
	*/
	this.postProcessor = new DOMPostProcessor();
	this.postProcessor.listenForDocumentFrom( this.treeBuilder ); 


	/** 
	* Conversion from HTML DOM to WikiDOM.  This is not needed if plain HTML
	* DOM output is desired, so it should only be registered to the
	* DOMPostProcessor 'document' event if WikiDom output is requested. We
	* could emit events for 'dom', 'wikidom', 'html' and so on, but only
	* actually set up the needed pipeline stages if a listener is registered.
	* Overriding the addListener method should make this possible.
	*/
	this.DOMConverter = new DOMConverter();


	// Lame version for now, see above for an idea for the external async
	// interface and pipeline setup
	this.postProcessor.addListener( 'document', this.forwardDocument.bind( this ) );


}

// Inherit from EventEmitter
ParserPipeline.prototype = new events.EventEmitter();
ParserPipeline.prototype.constructor = ParserPipeline;


/** 
 * Token stream transformations to register by type and per phase. The
 * possible ranks for individual transformation registrations are [0,1)
 * (excluding 1.0) for sync01, [1,2) for async12 and [2,3) for sync23.
 *
 * Should perhaps be moved to mediawiki.parser.environment.js, so that all
 * configuration can be found in a single place.
 */
ParserPipeline.prototype._transformers = {
	'text/wiki': {
		// Synchronous in-order per input
		sync01: 
			[ 
				OnlyInclude,
				IncludeOnly, 
				NoInclude
				// Insert TokenCollectors for extensions here (don't expand
				// templates in extension contents); wrap collected tokens in
				// special extension token.
				/* Extension1, */
				/* Extension2, */
			],
		/* 
		* Asynchronous out-of-order per input. Each async transform can only
		* operate on a single input token, but can emit multiple output
		* tokens. If multiple tokens need to be collected per-input, then a
		* separate collection transform in sync01 can be used to wrap the
		* collected tokens into a single one later processed in an async12
		* transform.
		*/
		async12: 
			[ 
				TemplateHandler,
				// Expand attributes after templates to avoid expanding unused branches
				AttributeExpander,
				WikiLinkHandler,
				ExternalLinkHandler,
				BehaviorSwitchHandler,
				/* ExtensionHandler1, */
				/* ExtensionHandler2, */
			],
		// Synchronous in-order on fully expanded token stream (including
		// expanded templates etc).
		sync23:
			[ 
				QuoteTransformer, 
				PostExpandParagraphHandler,
				/* Cite, */
				/* ListHandler, */
				Sanitizer 
			]
	}
};

/**
 * Add all transformers to a token transform manager for a given input type
 * and phase.
 */
ParserPipeline.prototype._addTransformers = function ( type, phase, manager, isInclude ) 
{
	var transformers;
	try {
		transformers = this._transformers[type][phase];
	} catch ( e ) {
		console.warn( 'Error while looking for token transformers for ' + 
				type + ' and phase ' + phase );
		transformers = [];
	}
	for ( var i = 0, l = transformers.length; i < l; i++ ) {
		new transformers[i]( manager, isInclude );
	}
};


/**
 * Factory method for the input (up to async token transforms / phase two)
 * parts of the parser pipeline.
 *
 * @method
 * @param {String} Input type. Try 'text/wiki'.
 * @param {Object} Expanded template arguments to pass to the
 * AsyncTokenTransformManager.
 * @returns {Object} { first: <first stage>, last: AsyncTokenTransformManager }
 * First stage is supposed to implement a process() function
 * that can accept all input at once. The wikitext tokenizer for example
 * accepts the wiki text this way. The last stage of the input pipeline is
 * always an AsyncTokenTransformManager, which emits its output in events.
 */
ParserPipeline.prototype.makeInputPipeline = function ( inputType, args, isInclude ) {
	var pipelinePart = isInclude ? 'input-include' : 'input-toplevel';
	switch ( inputType ) {
		case 'text/wiki':
			//console.warn( 'makeInputPipeline ' + JSON.stringify( args ) );
			if ( this.pipelineCache['text/wiki'][pipelinePart].length ) {
				var pipe = this.pipelineCache['text/wiki'][pipelinePart].pop();
				pipe.last.args = args;
				return pipe;
			} else {
				var wikiTokenizer = new PegTokenizer();

				/**
				* Token stream transformations.
				* This is where all the wiki-specific functionality is implemented.
				* See
				* https://www.mediawiki.org/wiki/Future/Parser_development/Token_stream_transformations
				*/
				var tokenPreProcessor = new TokenTransformManager
								.SyncTokenTransformManager ( this.env, 'text/wiki', 1, isInclude );
				tokenPreProcessor.listenForTokensFrom ( wikiTokenizer );

				this._addTransformers( 'text/wiki', 'sync01', 
						tokenPreProcessor, isInclude );


				var tokenExpander = new TokenTransformManager.AsyncTokenTransformManager (
							{
								'input': this.makeInputPipeline.bind( this ),
								'attributes': this.makeAttributePipeline.bind( this )
							},
							args, this.env, inputType, 2.0, isInclude
						);

				// Register template expansion extension
				this._addTransformers( 'text/wiki', 'async12', 
						tokenExpander, isInclude );

				tokenExpander.listenForTokensFrom ( tokenPreProcessor );
				// XXX: hack.
				tokenExpander.inputType = inputType;
				tokenPreProcessor.inputType = inputType;
			
				return new CachedTokenPipeline( 
						this.cachePipeline.bind( this, 'text/wiki', pipelinePart ),
						wikiTokenizer,
						tokenExpander,
						isInclude
						);
			}
			break;

		default:
			console.trace();
			throw "ParserPipeline.makeInputPipeline: Unsupported input type " + inputType;
	}
};



/**
 * Factory for attribute transformations, with input type implicit in the
 * environment.
 */
ParserPipeline.prototype.makeAttributePipeline = function ( inputType, args, isInclude ) {
	var pipelinePart = isInclude ? 'attribute-include' : 'attribute-toplevel';
	//console.warn( 'makeAttributePipeline: ' + pipelinePart);
	if ( this.pipelineCache[inputType][pipelinePart].length ) {
		var pipe = this.pipelineCache[inputType][pipelinePart].pop();
		pipe.last.args = args;
		//console.warn( 'from cache' + JSON.stringify( pipe.last.transformers, null, 2 ) );
		return pipe;
	} else {
		/**
		* Token stream transformations.
		* This is where all the wiki-specific functionality is implemented.
		* See https://www.mediawiki.org/wiki/Future/Parser_development/Token_stream_transformations
		*/
		var tokenPreProcessor = new TokenTransformManager
					.SyncTokenTransformManager ( this.env, inputType, 1, isInclude );

		this._addTransformers( inputType, 'sync01', tokenPreProcessor, isInclude );

		new NoInclude( tokenPreProcessor );

		var tokenExpander = new TokenTransformManager.AsyncTokenTransformManager (
				{
					'input': this.makeInputPipeline.bind( this ),
					'attributes': this.makeAttributePipeline.bind( this )
				},
				args, this.env, inputType, 2, isInclude
				);
		// Add token transformers
		this._addTransformers( 'text/wiki', 'async12', 
				tokenExpander, isInclude );

		tokenExpander.listenForTokensFrom ( tokenPreProcessor );

		//console.warn( 'new pipe' + JSON.stringify( tokenExpander.transformers, null, 2 ) );
		return new CachedTokenPipeline( 
				this.cachePipeline.bind( this, inputType, pipelinePart ),
				tokenPreProcessor,
				tokenExpander,
				isInclude
				);
	}
};

ParserPipeline.prototype.cachePipeline = function ( inputType, pipelinePart, pipe ) {
	var cache = this.pipelineCache[inputType][pipelinePart];
	if ( cache && cache.length < 5 ) {
		cache.push( pipe );
	}
};



/**
 * Feed the parser pipeline with some input, the output is emitted in events.
 *
 * @method
 * @param {Mixed} All arguments are passed through to the underlying input
 * pipeline's first element's process() method. For a wikitext pipeline (the
 * default), this would be the wikitext to tokenize:
 * pipeline.parse ( wikiText );
 */
ParserPipeline.prototype.parse = function ( ) {
	// Set the pipeline in motion by feeding the first element with the given
	// arguments.
	this.inputPipeline.process.apply( this.inputPipeline , arguments );
};

// Just bubble up the document event from the pipeline
ParserPipeline.prototype.forwardDocument = function ( document ) {
	this.emit( 'document', document );
};


// XXX: remove JSON serialization here, that should only be performed when
// needed (and normally without pretty-printing).
ParserPipeline.prototype.getWikiDom = function ( document ) {
	return JSON.stringify(
				this.DOMConverter.HTMLtoWiki( document.body ),
				null,
				2
			);
};

ParserPipeline.prototype.getLinearModel = function( document ) {
	return JSON.stringify( ConvertDOMToLM( document.body ), null, 2 );
};


/************************ CachedTokenPipeline ********************************/

/**
 * Wrap a part of a pipeline. The last member of the pipeline is supposed to
 * emit 'end' and 'chunk' events, while the first is supposed to support a
 * process() method that sets the pipeline in motion.
 *
 * @class
 * @constructor
 * @param {Function} returnToCacheCB: Callback to return the
 * CachedTokenPipeline to a cache when processing has finished
 * @param {Object} first: First stage of the pipeline
 * @param {Object} last: Last stage of the pipeline
 */
function CachedTokenPipeline ( returnToCacheCB, first, last, isInclude ) {
	this.returnToCacheCB = returnToCacheCB;
	this.first = first;
	this.last = last;
	this.last.addListener( 'end', this.forwardEndAndRecycleSelf.bind( this ) );
	this.last.addListener( 'chunk', this.forwardChunk.bind( this ) );
	this.isInclude = isInclude;
}

// Inherit from EventEmitter
CachedTokenPipeline.prototype = new events.EventEmitter();
CachedTokenPipeline.prototype.constructor = CachedTokenPipeline;


/**
 * Feed input tokens to the first pipeline stage
 */
CachedTokenPipeline.prototype.process = function ( chunk ) {
	//console.warn( 'CachedTokenPipeline::process: ' + JSON.stringify( chunk ) );
	this.first.process( chunk );
};


/**
 * Forward chunks to our listeners
 */
CachedTokenPipeline.prototype.forwardChunk = function ( chunk ) {
	//console.warn( 'CachedTokenPipeline.forwardChunk: ' +
	//			JSON.stringify( chunk, null, 2 )
	//		);

	this.emit( 'chunk', chunk );
};


/**
 * Chunk and end event consumer and emitter, that removes all listeners from
 * the given pipeline stage and returns it to a cache.
 */
CachedTokenPipeline.prototype.forwardEndAndRecycleSelf = function ( ) {
	//console.warn( 'CachedTokenPipeline.forwardEndAndRecycleSelf: ' + 
	//		JSON.stringify( this.listeners( 'chunk' ), null, 2 ) );
	// first, forward the event
	this.emit( 'end' );
	// now recycle self
	if ( ! this.atTopLevel ) {
		this.removeAllListeners( 'end' );
		this.removeAllListeners( 'chunk' );
		this.returnToCacheCB ( this );
	}
};




if (typeof module == "object") {
	module.exports.ParserPipeline = ParserPipeline;
}
