import { Meteor } from 'meteor/meteor';
import _ from 'underscore';
import s from 'underscore.string';

import { settings } from '../../settings';
import { callbacks } from '../../callbacks';
import { Subscriptions, Messages } from '../../models';
import { Markdown } from '../../markdown/server';
import { Logger } from '../../logger';

/**
 * This class allows translation providers to
 * register,load and also returns the active provider.
 */
export class TranslationProviderRegistry {
	/**
	 * Registers the translation provider into the registry.
	 * @param {*} provider
	 */
	static registerProvider(provider) {
		// get provider information
		const metadata = provider._getProviderMetadata();
		if (!TranslationProviderRegistry._providers) {
			TranslationProviderRegistry._providers = {};
		}
		TranslationProviderRegistry._providers[metadata.name] = provider;
	}

	/**
	 * Return the active Translation provider
	 */
	static getActiveProvider() {
		return TranslationProviderRegistry._providers[TranslationProviderRegistry._activeProvider];
	}

	/**
	 * Make the activated provider by setting as the active.
	 */
	static loadActiveServiceProvider() {
		settings.get('AutoTranslate_ServiceProvider', (key, value) => {
			TranslationProviderRegistry._activeProvider = value;
		});
	}
}

/**
 * Generic auto translate base implementation.
 * This class provides generic parts of implementation for
 * tokenization, detokenization, call back register and unregister.
 * @abstract
 * @class
 */
export class AutoTranslate {
	/**
	 * Encapsulate the api key and provider settings.
	 * @constructor
	 */
	constructor() {
		this.name = '';
		this.languages = [];
		this.supportedLanguages = {};

		// Get Auto Translate Active flag
		settings.get('AutoTranslate_Enabled', (key, value) => {
			this.autoTranslateEnabled = value;
		});

		/** Register the active service provider on the 'AfterSaveMessage' callback.
		 *  So the registered provider will be invoked when a message is saved.
		 *  All the other inactive service provider must be deactivated.
		 */
		settings.get('AutoTranslate_ServiceProvider', (key, value) => {
			if (this.name === value) {
				this.registerAfterSaveMsgCallBack(this.name);
			} else {
				this.unRegisterAfterSaveMsgCallBack(this.name);
			}
		});
	}

	/**
	 * Extracts non-translatable parts of a message
	 * @param {object} message
	 * @return {object} message
	 */
	tokenize(message) {
		if (!message.tokens || !Array.isArray(message.tokens)) {
			message.tokens = [];
		}
		message = this.tokenizeEmojis(message);
		message = this.tokenizeCode(message);
		message = this.tokenizeURLs(message);
		message = this.tokenizeMentions(message);
		return message;
	}

	tokenizeEmojis(message) {
		let count = message.tokens.length;
		message.msg = message.msg.replace(/:[+\w\d]+:/g, function(match) {
			const token = `<i class=notranslate>{${ count++ }}</i>`;
			message.tokens.push({
				token,
				text: match,
			});
			return token;
		});

		return message;
	}

	tokenizeURLs(message) {
		let count = message.tokens.length;

		const schemes = settings.get('Markdown_SupportSchemesForLink').split(',').join('|');

		// Support ![alt text](http://image url) and [text](http://link)
		message.msg = message.msg.replace(new RegExp(`(!?\\[)([^\\]]+)(\\]\\((?:${ schemes }):\\/\\/[^\\)]+\\))`, 'gm'), function(match, pre, text, post) {
			const pretoken = `<i class=notranslate>{${ count++ }}</i>`;
			message.tokens.push({
				token: pretoken,
				text: pre,
			});

			const posttoken = `<i class=notranslate>{${ count++ }}</i>`;
			message.tokens.push({
				token: posttoken,
				text: post,
			});

			return pretoken + text + posttoken;
		});

		// Support <http://link|Text>
		message.msg = message.msg.replace(new RegExp(`((?:<|&lt;)(?:${ schemes }):\\/\\/[^\\|]+\\|)(.+?)(?=>|&gt;)((?:>|&gt;))`, 'gm'), function(match, pre, text, post) {
			const pretoken = `<i class=notranslate>{${ count++ }}</i>`;
			message.tokens.push({
				token: pretoken,
				text: pre,
			});

			const posttoken = `<i class=notranslate>{${ count++ }}</i>`;
			message.tokens.push({
				token: posttoken,
				text: post,
			});

			return pretoken + text + posttoken;
		});

		return message;
	}

	tokenizeCode(message) {
		let count = message.tokens.length;
		message.html = message.msg;
		message = Markdown.parseMessageNotEscaped(message);

		// Some parsers (e. g. Marked) wrap the complete message in a <p> - this is unnecessary and should be ignored with respect to translations
		const regexWrappedParagraph = new RegExp('^\\s*<p>|</p>\\s*$', 'gm');
		message.msg = message.msg.replace(regexWrappedParagraph, '');

		for (const tokenIndex in message.tokens) {
			if (message.tokens.hasOwnProperty(tokenIndex)) {
				const { token } = message.tokens[tokenIndex];
				if (token.indexOf('notranslate') === -1) {
					const newToken = `<i class=notranslate>{${ count++ }}</i>`;
					message.msg = message.msg.replace(token, newToken);
					message.tokens[tokenIndex].token = newToken;
				}
			}
		}

		return message;
	}

	tokenizeMentions(message) {
		let count = message.tokens.length;

		if (message.mentions && message.mentions.length > 0) {
			message.mentions.forEach((mention) => {
				message.msg = message.msg.replace(new RegExp(`(@${ mention.username })`, 'gm'), (match) => {
					const token = `<i class=notranslate>{${ count++ }}</i>`;
					message.tokens.push({
						token,
						text: match,
					});
					return token;
				});
			});
		}

		if (message.channels && message.channels.length > 0) {
			message.channels.forEach((channel) => {
				message.msg = message.msg.replace(new RegExp(`(#${ channel.name })`, 'gm'), (match) => {
					const token = `<i class=notranslate>{${ count++ }}</i>`;
					message.tokens.push({
						token,
						text: match,
					});
					return token;
				});
			});
		}

		return message;
	}

	deTokenize(message) {
		if (message.tokens && message.tokens.length > 0) {
			for (const { token, text, noHtml } of message.tokens) {
				message.msg = message.msg.replace(token, () => noHtml || text);
			}
		}
		return message.msg;
	}

	/**
	 * Triggers the translation of the prepared (tokenized) message
	 * and persists the result
	 * @public
	 * @param {object} message
	 * @param {object} room
	 * @param {object} targetLanguage
	 * @returns {object} unmodified message object.
	 */
	translateMessage(message, room, targetLanguage) {
		if (this.autoTranslateEnabled && this.apiKey) {
			let targetLanguages;
			if (targetLanguage) {
				targetLanguages = [targetLanguage];
			} else {
				targetLanguages = Subscriptions.getAutoTranslateLanguagesByRoomAndNotUser(room._id, message.u && message.u._id);
			}
			if (message.msg) {
				Meteor.defer(() => {
					let targetMessage = Object.assign({}, message);
					targetMessage.html = s.escapeHTML(String(targetMessage.msg));
					targetMessage = this.tokenize(targetMessage);

					const translations = this._translateMessage(targetMessage, targetLanguages);
					if (!_.isEmpty(translations)) {
						Messages.addTranslations(message._id, translations, TranslationProviderRegistry._activeProvider);
					}
				});
			}

			if (message.attachments && message.attachments.length > 0) {
				Meteor.defer(() => {
					for (const index in message.attachments) {
						if (message.attachments.hasOwnProperty(index)) {
							const attachment = message.attachments[index];
							if (attachment.description || attachment.text) {
								const translations = this._translateAttachmentDescriptions(attachment, targetLanguages);
								if (!_.isEmpty(translations)) {
									Messages.addAttachmentTranslations(message._id, index, translations);
								}
							}
						}
					}
				});
			}
		}
		return Messages.findOneById(message._id);
	}

	/**
	 * On changing the service provider, the callback in which the translation
	 * is being requested needs to be switched to the new provider
	 * @protected
	 * @param {string} provider
	 */
	registerAfterSaveMsgCallBack(provider) {
		callbacks.add('afterSaveMessage', this.translateMessage.bind(this), callbacks.priority.MEDIUM, provider);
	}

	/**
	 * On changing the service provider, the callback in which the translation
	 * is being requested needs to be deactivated for the all other translation providers
	 * @protected
	 * @param {string} provider
	 */
	unRegisterAfterSaveMsgCallBack(provider) {
		callbacks.remove('afterSaveMessage', provider);
	}

	/**
	 * Returns metadata information about the service provider which is used by
	 * the generic implementation
	 * @abstract
	 * @protected
	 * @returns { name, displayName, settings }
		};
	 */
	_getProviderMetadata() {
		Logger.warn('must be implemented by subclass!', '_getProviderMetadata');
	}


	/**
	 * Provides the possible languages _from_ which a message can be translated into a target language
	 * @abstract
	 * @protected
	 * @param {string} target - the language into which shall be translated
	 * @returns [{ language, name }]
	 */
	getSupportedLanguages(target) {
		Logger.warn('must be implemented by subclass!', 'getSupportedLanguages', target);
	}

	/**
	 * Performs the actual translation of a message,
	 * usually by sending a REST API call to the service provider.
	 * @abstract
	 * @protected
	 * @param {object} message
	 * @param {object} targetLanguages
	 * @return {object}
	 */
	_translateMessage(message, targetLanguages) {
		Logger.warn('must be implemented by subclass!', '_translateMessage', message, targetLanguages);
	}

	/**
	 * Performs the actual translation of an attachment (precisely its description),
	 * usually by sending a REST API call to the service provider.
	 * @abstract
	 * @param {object} attachment
	 * @param {object} targetLanguages
	 * @returns {object} translated messages for each target language
	 */
	_translateAttachmentDescriptions(attachment, targetLanguages) {
		Logger.warn('must be implemented by subclass!', '_translateAttachmentDescriptions', attachment, targetLanguages);
	}
}

Meteor.startup(() => {
	TranslationProviderRegistry.loadActiveServiceProvider();
});
