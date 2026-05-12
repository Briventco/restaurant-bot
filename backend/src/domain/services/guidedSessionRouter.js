function createGuidedSessionRouter({
  normalizeText,
  menuService,
  conversationSessionRepo,
  orderService,
  restaurantRepo,
  chatOrchestrator,
  flowStates,
  sendText,
  resolveMenuSelection,
  looksLikeQuestion,
  extractInlineFulfillmentType,
  extractInlineAddress,
  calculateMatchedTotal,
  buildGuidedConfirmPrompt,
  buildAddressPrompt,
  buildDeliveryOrPickupPrompt,
  buildMenuWelcome,
  extractInlineQuantity,
  buildSelectedItemPrompt,
  toPositiveInteger,
  buildMatchedFromSession,
  looksLikeAddIntent,
  looksLikeRemoveIntent,
  looksLikeFulfillmentChange,
  looksLikeOrderRestart,
  mergeMatchedItems,
  removeMatchedItems,
  buildGuidedOrderConfirmedMessage,
}) {
  function isMenuIntent(lower) {
    const text = String(lower || "").trim();
    return (
      text === "menu" ||
      text === "menuu" ||
      text === "start" ||
      text.includes("order again") ||
      text.includes("start again")
    );
  }

  function isStopOrCancelIntent(lower) {
    const text = String(lower || "").trim();
    return (
      text === "cancel" ||
      text === "cancel order" ||
      text.startsWith("cancel ") ||
      text === "stop" ||
      text === "stope" ||
      text.includes("stop nah") ||
      text.includes("never mind") ||
      text.includes("nevermind")
    );
  }

  function isAffirmativeIntent(lower) {
    const text = String(lower || "").trim();
    return ["yes", "y", "yeah", "yep", "confirm", "go ahead"].includes(text);
  }

  function isNegativeIntent(lower) {
    const text = String(lower || "").trim();
    return ["no", "n", "nope", "nah", "cancel", "stop"].includes(text);
  }

  function extractQuantityEditIntent(rawText) {
    const text = String(rawText || "").trim();
    if (!text) {
      return null;
    }

    const patterns = [
      /\bx\s*(\d+)\b/i,
      /\bmake(?:\s+\w+){0,3}\s+(\d+)\s*(?:x|portion|portions|plate|plates)?\b/i,
      /\bmake(?:\s+\w+){0,3}\s+x\s*(\d+)\b/i,
      /\bmake it\s+(\d+)\b/i,
      /\b(?:to|be)\s+(\d+)\s*(?:x|portion|portions|plate|plates)\b/i,
      /\b(\d+)\s*(?:x|portion|portions|plate|plates)\b/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match || !match[1]) {
        continue;
      }
      const quantity = Number(match[1]);
      if (Number.isFinite(quantity) && quantity > 0) {
        return Math.max(1, Math.round(quantity));
      }
    }

    return null;
  }

  function applyQuantityToSessionMatched(sessionMatched, session, quantity) {
    if (Array.isArray(sessionMatched) && sessionMatched.length) {
      if (sessionMatched.length === 1) {
        const single = sessionMatched[0];
        const price = Number(single.price || 0);
        const updated = [{
          ...single,
          quantity,
          subtotal: price * quantity,
        }];
        return updated;
      }
      return null;
    }

    if (session && session.itemId) {
      const price = Number(session.itemPrice || 0);
      return [
        {
          menuItemId: session.itemId,
          name: String(session.itemName || "").trim(),
          price,
          quantity,
          subtotal: price * quantity,
        },
      ];
    }

    return null;
  }

  function applyTargetedQuantityEdit(sessionMatched, rawText, quantity, normalizeTextFn) {
    if (!Array.isArray(sessionMatched) || !sessionMatched.length) {
      return null;
    }

    const text = String(rawText || "").trim();
    if (!text || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
      return null;
    }
    const lower = normalizeTextFn(text);

    const targetIndex = sessionMatched.findIndex((item) => {
      const name = String(item && item.name ? item.name : "").trim();
      if (!name) {
        return false;
      }
      const normalizedName = normalizeTextFn(name);
      if (normalizedName && lower.includes(normalizedName)) {
        return true;
      }

      const tokens = normalizedName.split(/\s+/).filter((token) => token.length >= 4);
      return tokens.some((token) => lower.includes(token));
    });

    if (targetIndex < 0) {
      return null;
    }

    const updated = sessionMatched.map((item) => ({ ...item }));
    const target = updated[targetIndex];
    const safeQuantity = Math.max(1, Math.round(Number(quantity)));
    const price = Number(target.price || 0);
    target.quantity = safeQuantity;
    target.subtotal = price * safeQuantity;
    return updated;
  }

  async function handleGuidedSession({
    restaurantId,
    normalized,
    session,
    customer,
    llmDecision = null,
    providerMessageId,
    sendMessage,
  }) {
    function resolveAiRescueAction() {
      const decision = llmDecision && typeof llmDecision === "object" ? llmDecision : null;
      if (!decision) {
        return "";
      }

      const intent = String(decision.intent || "").trim().toLowerCase();
      const suggestedAction = String(decision.suggestedAction || "").trim().toLowerCase();
      const confidence = Number(decision.confidence || 0);
      const entities = decision.entities && typeof decision.entities === "object" ? decision.entities : {};
      const fulfillmentType = String(entities.fulfillmentType || "").trim().toLowerCase();

      if (fulfillmentType === "delivery") {
        return "delivery";
      }
      if (fulfillmentType === "pickup") {
        return "pickup";
      }

      if (confidence < 0.6) {
        return "";
      }

      if (intent === "confirm") {
        return "confirm";
      }
      if (intent === "cancel") {
        return "cancel";
      }
      if (intent === "menu_request" || suggestedAction === "show_menu" || suggestedAction === "start_guided_flow") {
        return "menu";
      }
      if (intent === "add_item" || intent === "remove_item" || suggestedAction === "update_order") {
        return "edit";
      }

      return "";
    }

    const lower = normalizeText(normalized.text);
    const aiRescueAction = resolveAiRescueAction();
    const menuItems = await menuService.listAvailableMenuItems(restaurantId);

    if (!menuItems.length) {
      const replyText = "Menu is currently unavailable. Please try again later.";
      await conversationSessionRepo.clearSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId
      );
      await sendText(sendMessage, normalized.channelCustomerId, replyText);

      return {
        handled: true,
        shouldReply: true,
        type: "guided_menu_unavailable",
        replyText,
      };
    }

    if (isMenuIntent(lower) || aiRescueAction === "menu") {
      await conversationSessionRepo.clearSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId
      );
      const replyText = "Sure, let's start again.\n\n" + buildMenuWelcome(menuItems);
      await sendText(sendMessage, normalized.channelCustomerId, replyText);
      return {
        handled: true,
        shouldReply: true,
        type: "guided_restart_from_menu_intent",
        replyText,
      };
    }

    if ((isStopOrCancelIntent(lower) || aiRescueAction === "cancel") && session.state !== flowStates.AWAITING_ITEM) {
      await conversationSessionRepo.clearSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId
      );
      const replyText = "No problem, I have cancelled this draft order. Reply MENU whenever you want to order again.";
      await sendText(sendMessage, normalized.channelCustomerId, replyText);
      return {
        handled: true,
        shouldReply: true,
        type: "guided_cancelled_by_stop_intent",
        replyText,
      };
    }

    if (session.state === flowStates.AWAITING_ITEM) {
      // In guided ordering, keep parsing deterministic; use LLM only for clear question-style chat.
      if (looksLikeQuestion(lower, normalized.text)) {
        const restaurant = await restaurantRepo.getRestaurantById(restaurantId);
        const llmResult = await chatOrchestrator.maybeHandleWithLlm({
          restaurantId,
          normalized,
          restaurant,
          menuItems,
          sendMessage,
          allowGuidedFlow: false,
          activeOrder: null,
          sessionState: session,
        });

        if (llmResult && llmResult.handled !== false) {
          return llmResult;
        }
      }

      // Primary path: resolve requested items deterministically.
      const {
        matched: requestedMatched,
        unavailable: requestedUnavailable,
      } = await orderService.resolveRequestedItems({
        restaurantId,
        messageText: normalized.text,
      });
      if (Array.isArray(requestedUnavailable) && requestedUnavailable.length) {
        const availableList = (menuItems || [])
          .filter((item) => item && item.available)
          .map((item) => `- ${item.name} - N${item.price}`)
          .join("\n");
        const replyText =
          `Sorry, these item(s) are not available right now: ${requestedUnavailable.join(", ")}.` +
          `\n\nPlease order again using only available items:\n${availableList}`;
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_unavailable_item_requested",
          replyText,
        };
      }
      if (requestedMatched.length > 1) {
        const inlineFulfillmentType = extractInlineFulfillmentType(normalized.text);
        const inlineAddress =
          inlineFulfillmentType === "delivery"
            ? extractInlineAddress(normalized.text)
            : "";
        const cartTotal = calculateMatchedTotal(requestedMatched);

        if (inlineFulfillmentType === "pickup") {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: flowStates.AWAITING_CONFIRMATION,
              matched: requestedMatched,
              total: cartTotal,
              fulfillmentType: "pickup",
              deliveryAddress: "",
            }
          );

          const replyText = buildGuidedConfirmPrompt({
            matched: requestedMatched,
            total: cartTotal,
            fulfillmentType: "pickup",
            address: "",
          });
          await sendText(sendMessage, normalized.channelCustomerId, replyText);

          return {
            handled: true,
            shouldReply: true,
            type: "guided_multi_item_confirmation_prompt",
            replyText,
          };
        }

        if (inlineFulfillmentType === "delivery" && inlineAddress) {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: flowStates.AWAITING_CONFIRMATION,
              matched: requestedMatched,
              total: cartTotal,
              fulfillmentType: "delivery",
              deliveryAddress: inlineAddress,
            }
          );

          const replyText = buildGuidedConfirmPrompt({
            matched: requestedMatched,
            total: cartTotal,
            fulfillmentType: "delivery",
            address: inlineAddress,
          });
          await sendText(sendMessage, normalized.channelCustomerId, replyText);

          return {
            handled: true,
            shouldReply: true,
            type: "guided_multi_item_confirmation_prompt",
            replyText,
          };
        }

        if (inlineFulfillmentType === "delivery") {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: flowStates.AWAITING_ADDRESS,
              matched: requestedMatched,
              total: cartTotal,
              fulfillmentType: "delivery",
            }
          );

          const replyText = buildAddressPrompt();
          await sendText(sendMessage, normalized.channelCustomerId, replyText);

          return {
            handled: true,
            shouldReply: true,
            type: "guided_address_prompt",
            replyText,
          };
        }

        await conversationSessionRepo.upsertSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId,
          {
            state: flowStates.AWAITING_FULFILLMENT_TYPE,
            matched: requestedMatched,
            total: cartTotal,
          }
        );

        const replyText = buildDeliveryOrPickupPrompt({
          matched: requestedMatched,
          total: cartTotal,
        });
        await sendText(sendMessage, normalized.channelCustomerId, replyText);

        return {
          handled: true,
          shouldReply: true,
          type: "guided_multi_item_fulfillment_prompt",
          replyText,
        };
      }

      const selectedItem = resolveMenuSelection(menuItems, normalized.text);
      if (!selectedItem) {
        // If user is not providing an item, allow conversational LLM handling
        // instead of repeatedly forcing item clarification.
        const restaurant = await restaurantRepo.getRestaurantById(restaurantId);
        const llmResult = await chatOrchestrator.maybeHandleWithLlm({
          restaurantId,
          normalized,
          restaurant,
          menuItems,
          sendMessage,
          allowGuidedFlow: false,
          activeOrder: null,
          sessionState: session,
        });
        if (llmResult && llmResult.handled !== false) {
          return llmResult;
        }

        const replyText =
          "I didn't catch a valid item from your message. Please send item names from the menu, for example: 1 chapman and 2 fried rice.";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_item_clarification",
          replyText,
        };
      }

      const inlineQuantity = extractInlineQuantity(normalized.text);
      const inlineFulfillmentType = extractInlineFulfillmentType(normalized.text);
      const inlineAddress =
        inlineFulfillmentType === "delivery"
          ? extractInlineAddress(normalized.text)
          : "";

      if (inlineQuantity) {
        const total = (Number(selectedItem.price) || 0) * inlineQuantity;

        if (inlineFulfillmentType === "pickup") {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: flowStates.AWAITING_CONFIRMATION,
              itemId: selectedItem.id,
              itemName: selectedItem.name,
              itemPrice: Number(selectedItem.price) || 0,
              quantity: inlineQuantity,
              total,
              fulfillmentType: "pickup",
              deliveryAddress: "",
            }
          );

          const replyText = buildGuidedConfirmPrompt({
            itemName: selectedItem.name,
            quantity: inlineQuantity,
            total,
            fulfillmentType: "pickup",
            address: "",
          });
          await sendText(sendMessage, normalized.channelCustomerId, replyText);

          return {
            handled: true,
            shouldReply: true,
            type: "guided_confirmation_prompt",
            replyText,
          };
        }

        if (inlineFulfillmentType === "delivery" && inlineAddress) {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: flowStates.AWAITING_CONFIRMATION,
              itemId: selectedItem.id,
              itemName: selectedItem.name,
              itemPrice: Number(selectedItem.price) || 0,
              quantity: inlineQuantity,
              total,
              fulfillmentType: "delivery",
              deliveryAddress: inlineAddress,
            }
          );

          const replyText = buildGuidedConfirmPrompt({
            itemName: selectedItem.name,
            quantity: inlineQuantity,
            total,
            fulfillmentType: "delivery",
            address: inlineAddress,
          });
          await sendText(sendMessage, normalized.channelCustomerId, replyText);

          return {
            handled: true,
            shouldReply: true,
            type: "guided_confirmation_prompt",
            replyText,
          };
        }

        if (inlineFulfillmentType === "delivery") {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: flowStates.AWAITING_ADDRESS,
              itemId: selectedItem.id,
              itemName: selectedItem.name,
              itemPrice: Number(selectedItem.price) || 0,
              quantity: inlineQuantity,
              total,
              fulfillmentType: "delivery",
            }
          );

          const replyText = buildAddressPrompt();
          await sendText(sendMessage, normalized.channelCustomerId, replyText);

          return {
            handled: true,
            shouldReply: true,
            type: "guided_address_prompt",
            replyText,
          };
        }

        await conversationSessionRepo.upsertSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId,
          {
            state: flowStates.AWAITING_FULFILLMENT_TYPE,
            itemId: selectedItem.id,
            itemName: selectedItem.name,
            itemPrice: Number(selectedItem.price) || 0,
            quantity: inlineQuantity,
            total,
          }
        );

        const replyText = buildDeliveryOrPickupPrompt({
          itemName: selectedItem.name,
          quantity: inlineQuantity,
          total,
        });
        await sendText(sendMessage, normalized.channelCustomerId, replyText);

        return {
          handled: true,
          shouldReply: true,
          type: "guided_fulfillment_prompt",
          replyText,
        };
      }

      await conversationSessionRepo.upsertSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId,
        {
          state: flowStates.AWAITING_QUANTITY,
          itemId: selectedItem.id,
          itemName: selectedItem.name,
          itemPrice: Number(selectedItem.price) || 0,
        }
      );

      const replyText = buildSelectedItemPrompt(selectedItem);
      await sendText(sendMessage, normalized.channelCustomerId, replyText);

      return {
        handled: true,
        shouldReply: true,
        type: "guided_quantity_prompt",
        replyText,
      };
    }

    if (session.state === flowStates.AWAITING_QUANTITY) {
      // Check if user wants to restart/change their order
      if (looksLikeOrderRestart && looksLikeOrderRestart(lower, normalized.text)) {
        await conversationSessionRepo.clearSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId
        );
        const menuItems = await menuService.listAvailableMenuItems(restaurantId);
        const replyText = "No problem! Let's start fresh.\n\n" + buildMenuWelcome(menuItems);
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_order_restart",
          replyText,
        };
      }

      const quantity = toPositiveInteger(normalized.text);
      if (!quantity) {
        const replyText = "Please reply with a valid quantity, for example: 2";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_invalid_quantity",
          replyText,
        };
      }

      const total = Number(session.itemPrice || 0) * quantity;
      await conversationSessionRepo.upsertSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId,
        {
          state: flowStates.AWAITING_FULFILLMENT_TYPE,
          quantity,
          total,
        }
      );

      const replyText = buildDeliveryOrPickupPrompt({
        itemName: session.itemName,
        quantity,
        total,
      });
      await sendText(sendMessage, normalized.channelCustomerId, replyText);

      return {
        handled: true,
        shouldReply: true,
        type: "guided_fulfillment_prompt",
        replyText,
      };
    }

    if (session.state === flowStates.AWAITING_FULFILLMENT_TYPE) {
      let fulfillmentType = "";
      const inlineFulfillmentType = extractInlineFulfillmentType(normalized.text);
      const quantityEdit = extractQuantityEditIntent(normalized.text);
      const sessionMatched = buildMatchedFromSession(session);

      if (
        lower === "d" ||
        lower === "delivery" ||
        inlineFulfillmentType === "delivery" ||
        aiRescueAction === "delivery"
      ) {
        fulfillmentType = "delivery";
      } else if (
        lower === "p" ||
        lower === "pickup" ||
        inlineFulfillmentType === "pickup" ||
        aiRescueAction === "pickup"
      ) {
        fulfillmentType = "pickup";
      }

      if (!fulfillmentType) {
        if (looksLikeAddIntent(lower) || looksLikeRemoveIntent(lower)) {
          const { matched: requestedMatched } = await orderService.resolveRequestedItems({
            restaurantId,
            messageText: normalized.text,
          });

          let nextMatched = sessionMatched;
          if (looksLikeAddIntent(lower) && requestedMatched.length) {
            nextMatched = mergeMatchedItems(sessionMatched, requestedMatched);
          } else if (looksLikeRemoveIntent(lower) && requestedMatched.length) {
            nextMatched = removeMatchedItems(sessionMatched, requestedMatched);
          }

          if (!nextMatched.length) {
            const replyText =
              "Your draft order would become empty after that change. Reply MENU to start again.";
            await sendText(sendMessage, normalized.channelCustomerId, replyText);
            return {
              handled: true,
              shouldReply: true,
              type: "guided_order_edit_would_empty",
              replyText,
            };
          }

          const updatedTotal = calculateMatchedTotal(nextMatched);
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              matched: nextMatched,
              total: updatedTotal,
              itemId: "",
              itemName: "",
              itemPrice: 0,
              quantity: 0,
            }
          );
          const replyText = buildDeliveryOrPickupPrompt({
            matched: nextMatched,
            total: updatedTotal,
            prefix: "Okay, I've updated your order.",
          });
          await sendText(sendMessage, normalized.channelCustomerId, replyText);
          return {
            handled: true,
            shouldReply: true,
            type: "guided_fulfillment_edit_updated",
            replyText,
          };
        }

        if (quantityEdit) {
          const updatedMatched =
            applyTargetedQuantityEdit(sessionMatched, normalized.text, quantityEdit, normalizeText) ||
            applyQuantityToSessionMatched(sessionMatched, session, quantityEdit);

          if (updatedMatched && updatedMatched.length) {
            const updatedTotal = calculateMatchedTotal(updatedMatched);
            await conversationSessionRepo.upsertSession(
              restaurantId,
              normalized.channel,
              normalized.channelCustomerId,
              {
                matched: updatedMatched,
                total: updatedTotal,
                itemId: "",
                itemName: "",
                itemPrice: 0,
                quantity: 0,
              }
            );
            const replyText = buildDeliveryOrPickupPrompt({
              matched: updatedMatched,
              total: updatedTotal,
              prefix: "Got it, I have updated your order.",
            });
            await sendText(sendMessage, normalized.channelCustomerId, replyText);
            return {
              handled: true,
              shouldReply: true,
              type: "guided_quantity_updated_awaiting_fulfillment",
              replyText,
            };
          }
        }

        if (aiRescueAction === "edit") {
          const replyText =
            "Sure, what would you like to change in your order?\nYou can say things like:\n- add 1 chapman\n- remove fried rice\n- make shawarma 2";
          await sendText(sendMessage, normalized.channelCustomerId, replyText);
          return {
            handled: true,
            shouldReply: true,
            type: "guided_edit_prompt_awaiting_fulfillment",
            replyText,
          };
        }

        // Check if user wants to restart/change their order only after
        // quantity edits were given a chance.
        if (looksLikeOrderRestart && looksLikeOrderRestart(lower, normalized.text)) {
          await conversationSessionRepo.clearSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId
          );
          const menuItems = await menuService.listAvailableMenuItems(restaurantId);
          const replyText = "No problem! Let's start fresh.\n\n" + buildMenuWelcome(menuItems);
          await sendText(sendMessage, normalized.channelCustomerId, replyText);
          return {
            handled: true,
            shouldReply: true,
            type: "guided_order_restart",
            replyText,
          };
        }

        const invalidAttempts = Number(session.invalidFulfillmentAttempts || 0) + 1;
        await conversationSessionRepo.upsertSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId,
          { invalidFulfillmentAttempts: invalidAttempts }
        );
        const replyText =
          invalidAttempts >= 2
            ? "I can do either one. Reply DELIVERY or PICKUP.\nIf you want to edit items, say EDIT ORDER.\nIf you want to restart, say MENU."
            : "Reply D for delivery or P for pickup.";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_invalid_fulfillment",
          replyText,
        };
      }

      if (quantityEdit) {
        const updatedMatched = applyQuantityToSessionMatched(sessionMatched, session, quantityEdit);
        if (updatedMatched && updatedMatched.length) {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              matched: updatedMatched,
              total: calculateMatchedTotal(updatedMatched),
              itemId: "",
              itemName: "",
              itemPrice: 0,
              quantity: 0,
            }
          );
        }
      }

      if (fulfillmentType === "delivery") {
        await conversationSessionRepo.upsertSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId,
          {
            state: flowStates.AWAITING_ADDRESS,
            fulfillmentType,
            invalidFulfillmentAttempts: 0,
          }
        );

        const replyText = buildAddressPrompt();
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_address_prompt",
          replyText,
        };
      }

      await conversationSessionRepo.upsertSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId,
        {
          state: flowStates.AWAITING_CONFIRMATION,
          fulfillmentType,
          deliveryAddress: "",
          invalidFulfillmentAttempts: 0,
        }
      );

      const nextMatched =
        quantityEdit && sessionMatched.length <= 1
          ? applyQuantityToSessionMatched(sessionMatched, session, quantityEdit) || sessionMatched
          : sessionMatched;
      const nextTotal = nextMatched.length
        ? calculateMatchedTotal(nextMatched)
        : quantityEdit
          ? Number(session.itemPrice || 0) * quantityEdit
          : Number(session.total || 0);
      const replyText = buildGuidedConfirmPrompt({
        matched: nextMatched.length ? nextMatched : null,
        itemName: session.itemName,
        quantity: quantityEdit || Number(session.quantity || 0),
        total: Number(nextTotal || 0),
        fulfillmentType,
        address: "",
      });
      await sendText(sendMessage, normalized.channelCustomerId, replyText);

      return {
        handled: true,
        shouldReply: true,
        type: "guided_confirmation_prompt",
        replyText,
      };
    }

    if (session.state === flowStates.AWAITING_ADDRESS) {
      // Check if user wants to restart/change their order
      if (looksLikeOrderRestart && looksLikeOrderRestart(lower, normalized.text)) {
        await conversationSessionRepo.clearSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId
        );
        const menuItems = await menuService.listAvailableMenuItems(restaurantId);
        const replyText = "No problem! Let's start fresh.\n\n" + buildMenuWelcome(menuItems);
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_order_restart",
          replyText,
        };
      }

      if (lower === "p" || lower === "pickup" || lower.includes("pick up")) {
        await conversationSessionRepo.upsertSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId,
          {
            state: flowStates.AWAITING_CONFIRMATION,
            fulfillmentType: "pickup",
            deliveryAddress: "",
          }
        );
        const replyText = buildGuidedConfirmPrompt({
          matched: Array.isArray(session.matched) ? session.matched : null,
          itemName: session.itemName,
          quantity: Number(session.quantity || 0),
          total: Number(session.total || 0),
          fulfillmentType: "pickup",
          address: "",
        });
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_switched_to_pickup",
          replyText,
        };
      }

      const address = String(normalized.text || "").trim();
      const lowerAddress = normalizeText(address);
      const isNonAddress =
        !address ||
        address.length < 4 ||
        new Set([
          "hi", "hello", "hey", "good morning", "good afternoon", "good evening",
          "thanks", "thank you", "thank u", "ok", "okay", "okk", "alright", "alr",
          "yes", "no", "y", "n", "sure", "nice", "great", "good",
        ]).has(lowerAddress);

      if (isNonAddress) {
        const replyText = buildAddressPrompt();
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_invalid_address",
          replyText,
        };
      }

      await conversationSessionRepo.upsertSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId,
        {
          state: flowStates.AWAITING_CONFIRMATION,
          fulfillmentType: "delivery",
          deliveryAddress: address,
        }
      );

      const replyText = buildGuidedConfirmPrompt({
        matched: Array.isArray(session.matched) ? session.matched : null,
        itemName: session.itemName,
        quantity: Number(session.quantity || 0),
        total: Number(session.total || 0),
        fulfillmentType: "delivery",
        address,
      });
      await sendText(sendMessage, normalized.channelCustomerId, replyText);

      return {
        handled: true,
        shouldReply: true,
        type: "guided_confirmation_prompt",
        replyText,
      };
    }

    if (session.state === flowStates.AWAITING_CONFIRMATION) {
      const sessionMatched = buildMatchedFromSession(session);
      const inlineFulfillmentType = extractInlineFulfillmentType(normalized.text);
      const inlineAddress =
        inlineFulfillmentType === "delivery"
          ? extractInlineAddress(normalized.text)
          : "";
      const lowerText = normalizeText(normalized.text);

      // Check if user wants to restart/change their order
      if (looksLikeOrderRestart && looksLikeOrderRestart(lowerText, normalized.text)) {
        await conversationSessionRepo.clearSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId
        );
        const menuItems = await menuService.listAvailableMenuItems(restaurantId);
        const replyText = "No problem! Let's start fresh.\n\n" + buildMenuWelcome(menuItems);
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_order_restart",
          replyText,
        };
      }

      if (looksLikeAddIntent(lowerText) || looksLikeRemoveIntent(lowerText) || looksLikeFulfillmentChange(lowerText)) {
        const { matched: requestedMatched } = await orderService.resolveRequestedItems({
          restaurantId,
          messageText: normalized.text,
        });

        let nextMatched = sessionMatched;
        if (looksLikeAddIntent(lowerText) && requestedMatched.length) {
          nextMatched = mergeMatchedItems(sessionMatched, requestedMatched);
        } else if (looksLikeRemoveIntent(lowerText) && requestedMatched.length) {
          nextMatched = removeMatchedItems(sessionMatched, requestedMatched);
        }

        if (!nextMatched.length) {
          await conversationSessionRepo.clearSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId
          );
          const replyText = "Your draft order is now empty. Send HI whenever you want to start a new order.";
          await sendText(sendMessage, normalized.channelCustomerId, replyText);
          return {
            handled: true,
            shouldReply: true,
            type: "guided_order_emptied",
            replyText,
          };
        }

        const nextTotal = calculateMatchedTotal(nextMatched);
        const nextFulfillmentType =
          inlineFulfillmentType || String(session.fulfillmentType || "").trim() || "";
        const nextAddress =
          nextFulfillmentType === "delivery"
            ? inlineAddress || String(session.deliveryAddress || "").trim()
            : "";

        if (nextFulfillmentType === "delivery" && !nextAddress) {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: flowStates.AWAITING_ADDRESS,
              matched: nextMatched,
              total: nextTotal,
              fulfillmentType: "delivery",
              deliveryAddress: "",
              itemId: "",
              itemName: "",
              itemPrice: 0,
              quantity: 0,
            }
          );

          const replyText = buildAddressPrompt();
          await sendText(sendMessage, normalized.channelCustomerId, replyText);
          return {
            handled: true,
            shouldReply: true,
            type: "guided_address_prompt",
            replyText,
          };
        }

        if (!nextFulfillmentType) {
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              state: flowStates.AWAITING_FULFILLMENT_TYPE,
              matched: nextMatched,
              total: nextTotal,
              itemId: "",
              itemName: "",
              itemPrice: 0,
              quantity: 0,
            }
          );

          const replyText = buildDeliveryOrPickupPrompt({
            matched: nextMatched,
            total: nextTotal,
            prefix: "Okay, I've updated your order.",
          });
          await sendText(sendMessage, normalized.channelCustomerId, replyText);
          return {
            handled: true,
            shouldReply: true,
            type: "guided_multi_item_fulfillment_prompt",
            replyText,
          };
        }

        await conversationSessionRepo.upsertSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId,
          {
            state: flowStates.AWAITING_CONFIRMATION,
            matched: nextMatched,
            total: nextTotal,
            fulfillmentType: nextFulfillmentType,
            deliveryAddress: nextAddress,
            itemId: "",
            itemName: "",
            itemPrice: 0,
            quantity: 0,
          }
        );

        const replyText = buildGuidedConfirmPrompt({
          matched: nextMatched,
          total: nextTotal,
          fulfillmentType: nextFulfillmentType,
          address: nextAddress,
          prefix: "Okay, I've updated your order.",
        });
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_order_updated",
          replyText,
        };
      }

      if (isNegativeIntent(lowerText) || aiRescueAction === "cancel") {
        await conversationSessionRepo.clearSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId
        );
        const replyText = "Order cancelled. Send HI to start again.";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_cancelled",
          replyText,
        };
      }

      if (aiRescueAction === "edit") {
        const replyText =
          "No problem. Tell me exactly what to change.\nExamples:\n- add 1 chapman\n- remove jollof rice\n- change to delivery";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_edit_prompt_confirmation",
          replyText,
        };
      }

      const quantityEditAtConfirm = extractQuantityEditIntent(normalized.text);
      if (quantityEditAtConfirm) {
        const updatedMatched =
          applyTargetedQuantityEdit(sessionMatched, normalized.text, quantityEditAtConfirm, normalizeText) ||
          applyQuantityToSessionMatched(sessionMatched, session, quantityEditAtConfirm);
        if (updatedMatched && updatedMatched.length) {
          const nextTotal = calculateMatchedTotal(updatedMatched);
          const nextFulfillmentType = String(session.fulfillmentType || "").trim().toLowerCase() || "pickup";
          const nextAddress =
            nextFulfillmentType === "delivery" ? String(session.deliveryAddress || "").trim() : "";
          await conversationSessionRepo.upsertSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId,
            {
              matched: updatedMatched,
              total: nextTotal,
              itemId: "",
              itemName: "",
              itemPrice: 0,
              quantity: 0,
            }
          );
          const replyText = buildGuidedConfirmPrompt({
            matched: updatedMatched,
            total: nextTotal,
            fulfillmentType: nextFulfillmentType,
            address: nextAddress,
            prefix: "Got it, I have updated your order.",
          });
          await sendText(sendMessage, normalized.channelCustomerId, replyText);
          return {
            handled: true,
            shouldReply: true,
            type: "guided_confirmation_updated",
            replyText,
          };
        }
      }

      if (!isAffirmativeIntent(lowerText) && aiRescueAction !== "confirm") {
        const invalidAttempts = Number(session.invalidConfirmationAttempts || 0) + 1;
        await conversationSessionRepo.upsertSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId,
          { invalidConfirmationAttempts: invalidAttempts }
        );
        const replyText =
          invalidAttempts >= 2
            ? "Quick options:\nYES - confirm order\nNO - cancel order\nEDIT ORDER - change items\nMENU - start over"
            : "Please reply YES to confirm or NO to cancel.";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_invalid_confirmation",
          replyText,
        };
      }

      if (sessionMatched.length) {
        const hasUnavailableItem = sessionMatched.some((sessionItem) => {
          const liveMenuItem = menuItems.find(
            (item) => String(item.id) === String(sessionItem.menuItemId || "")
          );

          return !liveMenuItem || !liveMenuItem.available;
        });

        if (hasUnavailableItem) {
          await conversationSessionRepo.clearSession(
            restaurantId,
            normalized.channel,
            normalized.channelCustomerId
          );
          const replyText = "One or more selected items are no longer available. Send HI to start again.";
          await sendText(sendMessage, normalized.channelCustomerId, replyText);
          return {
            handled: true,
            shouldReply: true,
            type: "guided_item_no_longer_available",
            replyText,
          };
        }
      }

      const menuItem =
        menuItems.find((item) => String(item.id) === String(session.itemId || "")) || null;
      if (!sessionMatched.length && (!menuItem || !menuItem.available)) {
        await conversationSessionRepo.clearSession(
          restaurantId,
          normalized.channel,
          normalized.channelCustomerId
        );
        const replyText = "That item is no longer available. Send HI to start again.";
        await sendText(sendMessage, normalized.channelCustomerId, replyText);
        return {
          handled: true,
          shouldReply: true,
          type: "guided_item_no_longer_available",
          replyText,
        };
      }

      const order =
        Array.isArray(session.matched) && session.matched.length
          ? await orderService.createGuidedOrderFromItems({
              restaurantId,
              customer,
              channel: normalized.channel,
              channelCustomerId: normalized.channelCustomerId,
              customerPhone: normalized.customerPhone,
              providerMessageId,
              matched: session.matched,
              fulfillmentType: String(session.fulfillmentType || "pickup"),
              deliveryAddress: String(session.deliveryAddress || "").trim(),
              rawMessage: normalized.text,
            })
          : await orderService.createGuidedOrder({
              restaurantId,
              customer,
              channel: normalized.channel,
              channelCustomerId: normalized.channelCustomerId,
              customerPhone: normalized.customerPhone,
              providerMessageId,
              menuItem,
              quantity: Number(session.quantity || 0),
              fulfillmentType: String(session.fulfillmentType || "pickup"),
              deliveryAddress: String(session.deliveryAddress || "").trim(),
            });

      await orderService.logInboundMessage(order, normalized.text, {
        providerMessageId,
      });

      await conversationSessionRepo.clearSession(
        restaurantId,
        normalized.channel,
        normalized.channelCustomerId
      );

      const replyText = buildGuidedOrderConfirmedMessage();
      await orderService.sendMessageToOrderCustomer(order, replyText, {
        type: "guided_order_confirmed",
        sourceAction: "guidedOrderConfirmed",
        sourceRef: order.id,
        providerMessageId,
      });

      return {
        handled: true,
        shouldReply: true,
        type: "guided_order_created",
        orderId: order.id,
        replyText,
      };
    }

    // Session exists but state not handled - DON'T clear it
    // Let upstream (AI router or fallback) try to handle
    // This prevents losing order context when customer says something unexpected
    return null;
  }

  return {
    handleGuidedSession,
  };
}

module.exports = {
  createGuidedSessionRouter,
};
