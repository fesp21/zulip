var message_events = (function () {

var exports = {};

function maybe_add_narrowed_messages(messages, msg_list, messages_are_new, local_id) {
    var ids = [];
    _.each(messages, function (elem) {
        ids.push(elem.id);
    });

    channel.post({
        url:      '/json/messages_in_narrow',
        idempotent: true,
        data:     {msg_ids: JSON.stringify(ids),
                   narrow:  JSON.stringify(narrow.public_operators())},
        timeout:  5000,
        success: function (data) {
            if (msg_list !== current_msg_list) {
                // We unnarrowed in the mean time
                return;
            }

            var new_messages = [];
            var elsewhere_messages = [];
            _.each(messages, function (elem) {
                if (data.messages.hasOwnProperty(elem.id)) {
                    elem.match_subject = data.messages[elem.id].match_subject;
                    elem.match_content = data.messages[elem.id].match_content;
                    new_messages.push(elem);
                } else {
                    elsewhere_messages.push(elem);
                }
            });

            new_messages = _.map(new_messages, message_store.add_message_metadata);
            message_util.add_messages(
                new_messages,
                msg_list,
                {messages_are_new: messages_are_new}
            );
            unread_ops.process_visible();
            notifications.possibly_notify_new_messages_outside_viewport(new_messages, local_id);
            notifications.notify_messages_outside_current_search(elsewhere_messages);
        },
        error: function () {
            // We might want to be more clever here
            setTimeout(function () {
                if (msg_list === current_msg_list) {
                    // Don't actually try again if we unnarrowed
                    // while waiting
                    maybe_add_narrowed_messages(messages, msg_list, messages_are_new, local_id);
                }
            }, 5000);
        }});
}


exports.insert_new_messages = function insert_new_messages(messages, local_id) {
    messages = _.map(messages, message_store.add_message_metadata);

    // You must add add messages to home_msg_list BEFORE
    // calling unread.process_loaded_messages.
    message_util.add_messages(messages, home_msg_list, {messages_are_new: true});
    message_util.add_messages(messages, message_list.all, {messages_are_new: true});

    if (narrow.active()) {
        if (narrow.filter().can_apply_locally()) {
            message_util.add_messages(messages, message_list.narrowed, {messages_are_new: true});
            notifications.possibly_notify_new_messages_outside_viewport(messages, local_id);
        } else {
            // if we cannot apply locally, we have to wait for this callback to happen to notify
            maybe_add_narrowed_messages(messages, message_list.narrowed, true, local_id);
        }
    } else {
        notifications.possibly_notify_new_messages_outside_viewport(messages, local_id);
    }

    activity.process_loaded_messages(messages);
    message_util.do_unread_count_updates(messages);

    if (narrow.narrowed_by_reply()) {
        // If you send a message when narrowed to a recipient, move the
        // pointer to it.

        var i;
        var selected_id = current_msg_list.selected_id();

        // Iterate backwards to find the last message sent_by_me, stopping at
        // the pointer position.
        for (i = messages.length-1; i>=0; i -= 1) {
            var id = messages[i].id;
            if (id <= selected_id) {
                break;
            }
            if (messages[i].sent_by_me && current_msg_list.get(id) !== undefined) {
                // If this is a reply we just sent, advance the pointer to it.
                current_msg_list.select_id(messages[i].id, {then_scroll: true,
                                                            from_scroll: true});
                break;
            }
        }
    }

    unread_ops.process_visible();
    notifications.received_messages(messages);
    stream_list.update_streams_sidebar();
    pm_list.update_private_messages();
};

exports.update_messages = function update_messages(events) {
    var msgs_to_rerender = [];
    var topic_edited = false;
    var changed_narrow = false;

    _.each(events, function (event) {
        var msg = message_store.get(event.message_id);
        if (msg === undefined) {
            return;
        }
        msgs_to_rerender.push(msg);

        msg.alerted = event.flags.indexOf("has_alert_word") !== -1;
        msg.mentioned = event.flags.indexOf("mentioned") !== -1 ||
                        event.flags.indexOf("wildcard_mentioned") !== -1;

        condense.un_cache_message_content_height(msg.id);

        if (event.rendered_content !== undefined) {
            msg.content = event.rendered_content;
        }

        var row = current_msg_list.get_row(event.message_id);
        if (row.length > 0) {
            message_edit.end(row);
        }

        if (event.subject !== undefined) {
            // A topic edit may affect multiple messages, listed in
            // event.message_ids. event.message_id is still the first message
            // where the user initiated the edit.
            topic_edited = true;

            var going_forward_change = _.indexOf(['change_later', 'change_all'], event.propagate_mode) >= 0;

            var stream_name = stream_data.get_sub_by_id(event.stream_id).name;
            var compose_stream_name = compose.stream_name();

            if (going_forward_change && stream_name && compose_stream_name) {
                if (stream_name.toLowerCase() === compose_stream_name.toLowerCase()) {
                    if (event.orig_subject === compose.subject()) {
                        compose.subject(event.subject);
                    }
                }
            }

            if (going_forward_change) {
                var current_id = current_msg_list.selected_id();
                var selection_changed_topic = _.indexOf(event.message_ids, current_id) >= 0;

                if (selection_changed_topic) {
                    var current_filter = narrow.filter();
                    if (current_filter && stream_name) {
                        if (current_filter.has_topic(stream_name, event.orig_subject)) {
                            var new_filter = current_filter.filter_with_new_topic(event.subject);
                            var operators = new_filter.operators();
                            var opts = {
                                trigger: 'topic change',
                                then_select_id: current_id,
                            };
                            narrow.activate(operators, opts);
                            changed_narrow = true;
                        }
                    }
                }
            }

            _.each(event.message_ids, function (id) {
                var msg = message_store.get(id);
                if (msg === undefined) {
                    return;
                }

                // Remove the recent topics entry for the old topics;
                // must be called before we update msg.subject
                stream_data.process_message_for_recent_topics(msg, true);
                // Update the unread counts; again, this must be called
                // before we update msg.subject
                unread.update_unread_topics(msg, event);

                msg.subject = event.subject;
                msg.subject_links = event.subject_links;
                message_store.set_topic_edit_properties(msg);
                // Add the recent topics entry for the new topics; must
                // be called after we update msg.subject
                stream_data.process_message_for_recent_topics(msg);
            });
        }

        if (event.orig_content !== undefined) {
            // Most correctly, we should do this for topic edits as
            // well; but we don't use the data except for content
            // edits anyway.
            var edit_history_entry = {
                edited_by: event.edited_by,
                prev_content: event.orig_content,
                prev_rendered_content: event.orig_rendered_content,
                prev_rendered_content_version: event.prev_rendered_content_version,
                timestamp: event.edit_timestamp,
            };
            // Add message's edit_history in message dict
            // For messages that are edited, edit_history needs to be added to message in frontend.
            if (msg.edit_history === undefined) {
                msg.edit_history = [];
            }
            msg.edit_history = [edit_history_entry].concat(msg.edit_history);
        }

        msg.last_edit_timestamp = event.edit_timestamp;
        delete msg.last_edit_timestr;

        notifications.received_messages([msg]);
        alert_words.process_message(msg);
    });

    // If a topic was edited, we re-render the whole view to get any
    // propagated edits to be updated (since the topic edits can have
    // changed the correct grouping of messages).
    if (topic_edited) {
        home_msg_list.rerender();
        // However, we don't need to rerender message_list.narrowed if
        // we just changed the narrow earlier in this function.
        if (!changed_narrow && current_msg_list === message_list.narrowed) {
            message_list.narrowed.rerender();
        }
    } else {
        home_msg_list.view.rerender_messages(msgs_to_rerender);
        if (current_msg_list === message_list.narrowed) {
            message_list.narrowed.view.rerender_messages(msgs_to_rerender);
        }
    }
    unread_ui.update_unread_counts();
    stream_list.update_streams_sidebar();
    pm_list.update_private_messages();
};


return exports;

}());
if (typeof module !== 'undefined') {
    module.exports = message_events;
}
