#include <pebble.h>

#define MAX_CARDS 20  // the maximum number of routes that will be down at a time
#define MAX_SCHEDULE_ITEMS 25

// AppMessage keys come from "messageKeys" in package.json (MESSAGE_KEY_*)

#define SCHEDULE_RETRY_MS 500

// One route in the main list, parsed from a "number name\nline1\nline2" card
typedef struct {
    char number[8];   // e.g. "14"
    char title[64];   // e.g. "14 Park/Forest/MLK"
    char inbound[32]; // e.g. "In: 5m*"
    char outbound[32];
} Card;

static Window *s_main_window;
static Layer *s_window_layer;
static TextLayer *s_time_layer; // Layer for displaying the current time
static TextLayer *s_status_layer;
static MenuLayer *s_menu_layer; // MenuLayer for displaying routes

// Schedule Window (menu for scheduled bus times for selected route)
static Window *s_schedule_window;
static MenuLayer *s_schedule_menu_layer;
static TextLayer *s_schedule_title_layer;
static int s_selected_route_index = -1;  // Which route was tapped; -1 = none
static char s_selected_route_number[8] = ""; // Parsed from card title (e.g. "14")

static int s_card_count = 0;
static Card s_cards[MAX_CARDS];
static char s_status_buffer[64] = "Loading...";

static int s_schedule_count = 0;
static char s_schedule_items[MAX_SCHEDULE_ITEMS][32];
static char s_schedule_status[32] = "Loading...";
static AppTimer *s_schedule_retry_timer;

// Updates the time layer with the current time
static void update_time() {
    time_t temp = time(NULL);
    struct tm *tick_time = localtime(&temp);

    // Static buffer to hold the time string (must be static as TextLayer doesn't copy)
    static char s_time_buffer[8];
    strftime(s_time_buffer, sizeof(s_time_buffer), clock_is_24h_style() ? "%H:%M" : "%I:%M", tick_time);

    // Drop the leading zero in 12h mode ("09:24" => "9:24")
    bool skip_zero = !clock_is_24h_style() && s_time_buffer[0] == '0';
    text_layer_set_text(s_time_layer, skip_zero ? s_time_buffer + 1 : s_time_buffer);
}

// Handler for time tick events (every minute)
static void tick_handler(struct tm *tick_time, TimeUnits units_changed) {
    update_time();
}

// --- Schedule Window (menu for bus times) ---

static uint16_t schedule_get_num_sections_callback(MenuLayer *menu_layer, void *data) {
    return 1;
}

static uint16_t schedule_get_num_rows_callback(MenuLayer *menu_layer, uint16_t section_index, void *data) {
    (void)menu_layer;
    (void)section_index;
    (void)data;
    return (s_schedule_count > 0) ? (uint16_t)s_schedule_count : 1;
}

static int16_t schedule_get_cell_height_callback(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
    (void)menu_layer;
    (void)cell_index;
    (void)data;
    return 44;
}

static void schedule_draw_row_callback(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index, void *data) {
    (void)data;
    GRect bounds = layer_get_bounds(cell_layer);

    const char *text = NULL;
    if (s_schedule_count > 0) {
        if (cell_index->row < s_schedule_count) {
            text = s_schedule_items[cell_index->row];
        }
    } else {
        text = (s_schedule_status[0] != '\0') ? s_schedule_status : "Loading...";
    }

    graphics_draw_text(ctx, text ? text : "",
                       fonts_get_system_font(FONT_KEY_GOTHIC_24),
                       GRect(4, 8, bounds.size.w - 8, bounds.size.h - 8),
                       GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
}

static void schedule_select_callback(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
    (void)menu_layer;
    (void)cell_index;
    (void)data;
    // TODO: handle tap on a time row when we have schedule data
}

#ifdef PBL_COLOR
static const struct {
    const char *number;
    uint32_t hex;
} ROUTE_COLORS[] = {
    { "2",  0x724D00 }, { "3",  0x61A4D5 }, { "4",  0x91BC64 }, { "5",  0xB15F51 },
    { "7",  0xCF896F }, { "8",  0x9574B1 }, { "9",  0x9574B1 }, { "9C", 0x9574B1 },
    { "14", 0x9574B1 }, { "15", 0x077239 }, { "16", 0xFDBE16 }, { "17", 0xA97A10 },
    { "20", 0xEA2327 }, { "24", 0x0A984A }, { "25", 0x068AC7 }, { "26", 0x7861A7 },
    { "27", 0xCD0779 }, { "30", 0xF59C1F }, { "32", 0x684F47 }, { "41", 0x4D6DA8 },
};

static GColor get_route_color(const char *route_number) {
    for (size_t i = 0; i < ARRAY_LENGTH(ROUTE_COLORS); i++) {
        if (strcmp(route_number, ROUTE_COLORS[i].number) == 0) {
            return GColorFromHEX(ROUTE_COLORS[i].hex);
        }
    }
    // Unlisted routes still need a color that shows up as a highlight on the white menu
    return GColorDarkGray;
}
#endif

// Sends a message to the JS side to request stop estimates for the selected route.
// The outbox may still be busy with a location request, so retry until it goes out.
static void send_stop_estimates_request(void *data) {
    s_schedule_retry_timer = NULL;

    DictionaryIterator *out_iter;
    AppMessageResult result = app_message_outbox_begin(&out_iter);

    if (result == APP_MSG_OK) {
        dict_write_uint8(out_iter, MESSAGE_KEY_REQUEST_SCHEDULE, 1);
        dict_write_cstring(out_iter, MESSAGE_KEY_ROUTE, s_selected_route_number);
        result = app_message_outbox_send();
    }

    if (result != APP_MSG_OK) {
        s_schedule_retry_timer = app_timer_register(SCHEDULE_RETRY_MS, send_stop_estimates_request, NULL);
    }
}

static void schedule_window_load(Window *window) {
    Layer *window_layer = window_get_root_layer(window);
    GRect bounds = layer_get_bounds(window_layer);

    window_set_background_color(window, GColorBlack);

    const int title_height = 28;

    // Title: show selected route name (copied, since the card list can refresh underneath us)
    static char title_buf[sizeof(((Card *)0)->title)] = "Schedule";
    if (s_selected_route_index >= 0 && s_selected_route_index < s_card_count) {
        strncpy(title_buf, s_cards[s_selected_route_index].title, sizeof(title_buf) - 1);
        title_buf[sizeof(title_buf) - 1] = '\0';
    }

    s_schedule_title_layer = text_layer_create(GRect(0, 0, bounds.size.w, title_height));
    text_layer_set_text(s_schedule_title_layer, title_buf);
    text_layer_set_font(s_schedule_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
    text_layer_set_text_alignment(s_schedule_title_layer, GTextAlignmentCenter);
#ifdef PBL_COLOR
    if (s_selected_route_number[0] != '\0') {
        GColor sched_color = get_route_color(s_selected_route_number);
        text_layer_set_background_color(s_schedule_title_layer, sched_color);
        text_layer_set_text_color(s_schedule_title_layer, gcolor_legible_over(sched_color));
    } else {
        text_layer_set_background_color(s_schedule_title_layer, GColorBlack);
        text_layer_set_text_color(s_schedule_title_layer, GColorWhite);
    }
#else
    text_layer_set_background_color(s_schedule_title_layer, GColorBlack);
    text_layer_set_text_color(s_schedule_title_layer, GColorWhite);
#endif
    layer_add_child(window_layer, text_layer_get_layer(s_schedule_title_layer));

    s_schedule_menu_layer = menu_layer_create(GRect(0, title_height, bounds.size.w, bounds.size.h - title_height));
    menu_layer_set_callbacks(s_schedule_menu_layer, NULL, (MenuLayerCallbacks){
        .get_num_sections = schedule_get_num_sections_callback,
        .get_num_rows = schedule_get_num_rows_callback,
        .get_cell_height = schedule_get_cell_height_callback,
        .draw_row = schedule_draw_row_callback,
        .select_click = schedule_select_callback,
    });
    menu_layer_set_click_config_onto_window(s_schedule_menu_layer, window);
    layer_add_child(window_layer, menu_layer_get_layer(s_schedule_menu_layer));

    // Start loading schedule
    s_schedule_count = 0;
    strncpy(s_schedule_status, "Loading...", sizeof(s_schedule_status) - 1);
    s_schedule_status[sizeof(s_schedule_status) - 1] = '\0';
    menu_layer_reload_data(s_schedule_menu_layer);

    send_stop_estimates_request(NULL);
}

static void schedule_window_unload(Window *window) {
    if (s_schedule_retry_timer) {
        app_timer_cancel(s_schedule_retry_timer);
        s_schedule_retry_timer = NULL;
    }
    text_layer_destroy(s_schedule_title_layer);
    menu_layer_destroy(s_schedule_menu_layer);
    s_schedule_title_layer = NULL;
    s_schedule_menu_layer = NULL;
}

// --- Menu Handlers ---

// Menu callback: Get number of sections
static uint16_t menu_get_num_sections_callback(MenuLayer *menu_layer, void *data) {
    return 1;
}

// Menu callback: Get number of rows
static uint16_t menu_get_num_rows_callback(MenuLayer *menu_layer, uint16_t section_index, void *data) {
    return s_card_count;
}

// Menu callback: Get cell height
static int16_t menu_get_cell_height_callback(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
    return 128; // Twice the size
}

// Menu callback: Draw row
static void menu_draw_row_callback(GContext* ctx, const Layer *cell_layer, MenuIndex *cell_index, void *data) {
    if (cell_index->row < s_card_count) {
        const Card *card = &s_cards[cell_index->row];
        GRect bounds = layer_get_bounds(cell_layer);

        int left_pad = 4;
#ifdef PBL_COLOR
        GColor route_color = get_route_color(card->number);
        GColor line_color = GColorBlack;
        if (menu_cell_layer_is_highlighted(cell_layer)) {
            // Full route color highlight, with text that stays readable on light route colors
            line_color = gcolor_legible_over(route_color);
            graphics_context_set_fill_color(ctx, route_color);
            graphics_fill_rect(ctx, bounds, 0, GCornerNone);
            graphics_context_set_text_color(ctx, line_color);
        } else {
            // Route color bar for normal state
            graphics_context_set_fill_color(ctx, route_color);
            graphics_fill_rect(ctx, GRect(0, 0, 6, bounds.size.h), 0, GCornerNone);
            left_pad = 10;
        }
#endif

        // Draw Route Name (Title)
        graphics_draw_text(ctx, card->title, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), 
                           GRect(left_pad, 5, bounds.size.w - left_pad - 4, 28), GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);

        // Draw Inbound
        graphics_draw_text(ctx, card->inbound, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD), 
                           GRect(left_pad, 35, bounds.size.w - left_pad - 4, 30), GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);

        // Draw Separator Line
#ifdef PBL_COLOR
        graphics_context_set_stroke_color(ctx, line_color);
#else
        graphics_context_set_stroke_color(ctx, menu_cell_layer_is_highlighted(cell_layer) ? GColorWhite : GColorBlack);
#endif
        graphics_draw_line(ctx, GPoint(left_pad, 70), GPoint(bounds.size.w - 4, 70));

        // Draw Outbound
        graphics_draw_text(ctx, card->outbound, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD), 
                           GRect(left_pad, 75, bounds.size.w - left_pad - 4, 30), GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
    }
}

// Menu callback: Select row
static void menu_select_callback(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
    if (cell_index->row < s_card_count) {
        s_selected_route_index = (int)cell_index->row;
        strncpy(s_selected_route_number, s_cards[s_selected_route_index].number,
                sizeof(s_selected_route_number) - 1);
        s_selected_route_number[sizeof(s_selected_route_number) - 1] = '\0';

        window_stack_push(s_schedule_window, true);
    }
}

// --- AppMessage Handlers ---

// Sends a message to the JS side to request new location/bus data
static void send_location_request(void) {
    DictionaryIterator *out_iter;
    AppMessageResult result = app_message_outbox_begin(&out_iter);

    if (result == APP_MSG_OK) {
        dict_write_uint8(out_iter, MESSAGE_KEY_REQUEST_NEARBY, 1);
        app_message_outbox_send();
    }
}

// Shows a message in place of the route list
static void show_status(const char *text) {
    strncpy(s_status_buffer, text, sizeof(s_status_buffer) - 1);
    s_status_buffer[sizeof(s_status_buffer) - 1] = '\0';
    text_layer_set_text(s_status_layer, s_status_buffer);
    layer_set_hidden(text_layer_get_layer(s_status_layer), false);
    layer_set_hidden(menu_layer_get_layer(s_menu_layer), true);
}

// Copies len chars of src into dst, truncating to fit and always terminating
static void copy_span(char *dst, size_t size, const char *src, size_t len) {
    if (len > size - 1) len = size - 1;
    memcpy(dst, src, len);
    dst[len] = '\0';
}

// Parses one card ("14 Park/Forest/MLK\nIn: 5m*\nOut: 12m") of len chars into its fields
static void parse_card(Card *card, const char *text, size_t len) {
    memset(card, 0, sizeof(*card));

    struct { char *dst; size_t size; } lines[] = {
        { card->title, sizeof(card->title) },
        { card->inbound, sizeof(card->inbound) },
        { card->outbound, sizeof(card->outbound) },
    };

    const char *end = text + len;
    const char *p = text;
    for (size_t i = 0; i < ARRAY_LENGTH(lines) && p < end; i++) {
        const char *nl = memchr(p, '\n', end - p);
        const char *line_end = nl ? nl : end;
        copy_span(lines[i].dst, lines[i].size, p, line_end - p);
        if (!nl) break;
        p = nl + 1;
    }

    // Route number is the title up to the first space ("14 Park/Forest/MLK" => "14")
    const char *space = strchr(card->title, ' ');
    copy_span(card->number, sizeof(card->number), card->title,
              space ? (size_t)(space - card->title) : strlen(card->title));
}

// Handles incoming messages from the JS side, parses the bus data string into cards, and updates the UI
static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
    Tuple *bus_tuple = dict_find(iterator, MESSAGE_KEY_CARDS);
    Tuple *schedule_tuple = dict_find(iterator, MESSAGE_KEY_SCHEDULE);
    Tuple *status_tuple = dict_find(iterator, MESSAGE_KEY_STATUS);

    if (bus_tuple) {
        APP_LOG(APP_LOG_LEVEL_INFO, "Got message: %s", bus_tuple->value->cstring);
        const char *bus_data = bus_tuple->value->cstring;

        // Split into cards on double newlines (up to MAX_CARDS)
        s_card_count = 0;
        const char *p = bus_data;
        while (*p != '\0' && s_card_count < MAX_CARDS) {
            const char *sep = strstr(p, "\n\n");
            size_t len = sep ? (size_t)(sep - p) : strlen(p);
            if (len > 0) {
                parse_card(&s_cards[s_card_count++], p, len);
            }
            if (!sep) break;
            p = sep + 2;
        }

        APP_LOG(APP_LOG_LEVEL_INFO, "Parsed %d cards", s_card_count);

        // Hide loading indicator if we have data
        if (s_card_count > 0) {
            layer_set_hidden(text_layer_get_layer(s_status_layer), true);
            layer_set_hidden(menu_layer_get_layer(s_menu_layer), false);
        } else {
            show_status("No data");
        }

        // Reload menu data, keeping the selection inside the new list
        menu_layer_reload_data(s_menu_layer);
        MenuIndex selected = menu_layer_get_selected_index(s_menu_layer);
        if (s_card_count > 0 && selected.row >= s_card_count) {
            menu_layer_set_selected_index(s_menu_layer, MenuIndex(0, s_card_count - 1), MenuRowAlignBottom, false);
        }

    } else if (status_tuple) {
        // No routes to show (nothing nearby, or the phone couldn't fetch them)
        APP_LOG(APP_LOG_LEVEL_INFO, "Got status: %s", status_tuple->value->cstring);
        s_card_count = 0;
        menu_layer_reload_data(s_menu_layer);
        show_status(status_tuple->value->cstring);

    } else if (!schedule_tuple) {
        APP_LOG(APP_LOG_LEVEL_ERROR, "No known tuple found");
    }

    // Ignore schedules that aren't for the route currently on screen
    Tuple *route_tuple = dict_find(iterator, MESSAGE_KEY_ROUTE);
    if (schedule_tuple && (!s_schedule_menu_layer ||
            (route_tuple && strcmp(route_tuple->value->cstring, s_selected_route_number) != 0))) {
        schedule_tuple = NULL;
    }

    if (schedule_tuple) {
        APP_LOG(APP_LOG_LEVEL_INFO, "Got schedule: %s", schedule_tuple->value->cstring);
        const char *sched = schedule_tuple->value->cstring;

        // Clear previous schedule
        for (int i = 0; i < MAX_SCHEDULE_ITEMS; i++) {
            memset(s_schedule_items[i], 0, sizeof(s_schedule_items[i]));
        }
        s_schedule_count = 0;

        if (!sched || strlen(sched) == 0) {
            strncpy(s_schedule_status, "No data", sizeof(s_schedule_status) - 1);
            s_schedule_status[sizeof(s_schedule_status) - 1] = '\0';
        } else {
            // Split into rows by '\n'
            int item_idx = 0;
            int buf_pos = 0;

            for (size_t i = 0; sched[i] != '\0' && item_idx < MAX_SCHEDULE_ITEMS; i++) {
                if (sched[i] == '\n') {
                    if (buf_pos > 0) {
                        s_schedule_count++;
                        item_idx++;
                        buf_pos = 0;
                    }
                    continue;
                }

                if (buf_pos < (int)sizeof(s_schedule_items[0]) - 1) {
                    s_schedule_items[item_idx][buf_pos++] = sched[i];
                }
            }

            if (buf_pos > 0 && item_idx < MAX_SCHEDULE_ITEMS) {
                s_schedule_count++;
            }

            if (s_schedule_count == 0) {
                strncpy(s_schedule_status, "No upcoming buses", sizeof(s_schedule_status) - 1);
                s_schedule_status[sizeof(s_schedule_status) - 1] = '\0';
            } else {
                s_schedule_status[0] = '\0';
            }
        }

        menu_layer_reload_data(s_schedule_menu_layer);
    }
}

// Logs an error if an incoming message is dropped
static void inbox_dropped_callback(AppMessageResult reason, void *context) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "Message dropped");
}

// Periodically requests updates (every 30 seconds)
static void timer_callback(void *data) {
    send_location_request();
    app_timer_register(30000, timer_callback, NULL);
}

// Initializes the window's UI elements
static void window_load(Window *window) {
    s_window_layer = window_get_root_layer(window);
    GRect bounds = layer_get_bounds(s_window_layer);

    // Time Layer (Top)
    s_time_layer = text_layer_create(GRect(0, 0, bounds.size.w, 30));
    text_layer_set_font(s_time_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
    text_layer_set_text_alignment(s_time_layer, GTextAlignmentCenter);
    text_layer_set_background_color(s_time_layer, GColorBlack);
    text_layer_set_text_color(s_time_layer, GColorWhite);
    layer_add_child(s_window_layer, text_layer_get_layer(s_time_layer));

    // Status layer (for loading indicator) - Center it
    s_status_layer = text_layer_create(GRect(4, 60, bounds.size.w - 8, 66));
    text_layer_set_text(s_status_layer, s_status_buffer);
    text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
    text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
    text_layer_set_background_color(s_status_layer, GColorWhite);
    layer_add_child(s_window_layer, text_layer_get_layer(s_status_layer));

    // Menu Layer (Below Time Layer)
    s_menu_layer = menu_layer_create(GRect(0, 30, bounds.size.w, bounds.size.h - 30));
    menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks){
        .get_num_sections = menu_get_num_sections_callback,
        .get_num_rows = menu_get_num_rows_callback,
        .get_cell_height = menu_get_cell_height_callback,
        .draw_row = menu_draw_row_callback,
        .select_click = menu_select_callback, // Added select callback
    });
    menu_layer_set_click_config_onto_window(s_menu_layer, window);
    layer_add_child(s_window_layer, menu_layer_get_layer(s_menu_layer));
    
    // Initially hide menu until data loads
    layer_set_hidden(menu_layer_get_layer(s_menu_layer), true);

    // Initialize time immediately
    update_time();
}

// Destroys the UI elements when the window is unloaded
static void window_unload(Window *window) {
    text_layer_destroy(s_time_layer);
    text_layer_destroy(s_status_layer);
    menu_layer_destroy(s_menu_layer);
}

// Sets up the main window, registers handlers, and starts the initial timer
static void init(void) {
    s_main_window = window_create();
    window_set_window_handlers(s_main_window, (WindowHandlers) {
        .load = window_load,
        .unload = window_unload,
    });
    
    // Create Schedule Window (menu for scheduled times per route)
    s_schedule_window = window_create();
    window_set_window_handlers(s_schedule_window, (WindowHandlers) {
        .load = schedule_window_load,
        .unload = schedule_window_unload,
    });

    window_stack_push(s_main_window, true);

    // Register with TickTimerService
    tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);

    app_message_register_inbox_received(inbox_received_callback);
    app_message_register_inbox_dropped(inbox_dropped_callback);

    app_message_open(2048, 2048);

    // Delay first request by 2 seconds to let JS initialize
    app_timer_register(2000, timer_callback, NULL);
}

// Cleans up the main window on app exit
static void deinit(void) {
    window_destroy(s_main_window);
    window_destroy(s_schedule_window);
}

// The application entry point
int main(void) {
    init();
    app_event_loop();
    deinit();
}
