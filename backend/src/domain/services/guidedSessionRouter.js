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
  mergeMatchedItems,
  removeMatchedItems,
  buildGuidedOrderConfirmedMessage,
}) {
  function extractQuantityEditIntent(rawText) {
    const text = String(rawText || "").trim();
    if (!text) {
      return null;
    }

    const patterns = [
      /\bmake(?:\s+\w+){0,3}\s+(\d+)\s*(?:x|portion|portions|plate|plates)?\b/i,
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

  async function handleGuidedSession({
    restaurantId,
    normalized,
    session,
    customer,
    providerMessageId,
    sendMessage,
  }) {
    const lower = normalizeText(normalized.text);
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

      if (lower === "d" || lower === "delivery" || inlineFulfillmentType === "delivery") {
        fulfillmentType = "delivery";
      } else if (lower === "p" || lower === "pickup" || inlineFulfillmentType === "pickup") {
        fulfillmentType = "pickup";
      }

      if (!fulfillmentType) {
        const replyText = "Reply D for delivery or P for pickup.";
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
      const address = String(normalized.text || "").trim();
      if (!address) {
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

      if (lower === "no" || lower === "n") {
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

      if (lower !== "yes" && lower !== "y") {
        const replyText = "Please reply YES to confirm or NO to cancel.";
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
