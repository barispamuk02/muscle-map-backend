// Pure read-only billing health interpretation, independently testable.
export function evaluateBillingHealth(row) {
    const fields=['pending_risk_events','unmatched_risk_events','recorded_payments','subscription_owners','currently_entitled_users'];
    const counts={};
    for(const key of fields){
        const value=Number(row?.[key]);
        if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid aggregate '+key);
        counts[key]=value;
    }
    if(counts.unmatched_risk_events>counts.pending_risk_events)
        throw Error('Unmatched risk count exceeds pending total');
    return {
        pendingRiskEvents:counts.pending_risk_events,
        unmatchedRiskEvents:counts.unmatched_risk_events,
        recordedPayments:counts.recorded_payments,
        subscriptionOwners:counts.subscription_owners,
        currentlyEntitledUsers:counts.currently_entitled_users,
        needsReview:counts.pending_risk_events>0
    };
}
