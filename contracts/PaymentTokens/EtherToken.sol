pragma solidity 0.4.26;

import "../AccessControl/AccessControlled.sol";
import "../Reclaimable.sol";
import "../IsContract.sol";
import "../Standards/IWithdrawableToken.sol";
import "../Standards/IERC223Token.sol";
import "../Standards/IERC223Callback.sol";
import "../Standards/IContractId.sol";
import "../SnapshotToken/Helpers/TokenMetadata.sol";
import "../SnapshotToken/Helpers/TrustlessTokenController.sol";
import "../SnapshotToken/StandardToken.sol";


contract EtherToken is
    IsContract,
    IContractId,
    AccessControlled,
    StandardToken,
    TrustlessTokenController,
    IWithdrawableToken,
    TokenMetadata,
    IERC223Token,
    Reclaimable
{
    ////////////////////////
    // Constants
    ////////////////////////

    string private constant NAME = "Ether Token";

    string private constant SYMBOL = "ETH-T";

    uint8 private constant DECIMALS = 18;

    ////////////////////////
    // Events
    ////////////////////////

    event LogDeposit(
        address indexed to,
        uint256 amount
    );

    event LogWithdrawal(
        address indexed from,
        uint256 amount
    );

    event LogWithdrawAndSend(
        address indexed from,
        address indexed to,
        uint256 amount
    );

    ////////////////////////
    // Constructor
    ////////////////////////

    constructor(IAccessPolicy accessPolicy)
        AccessControlled(accessPolicy)
        StandardToken()
        TokenMetadata(NAME, DECIMALS, SYMBOL, "")
        Reclaimable()
        public
    {
    }

    ////////////////////////
    // Public functions
    ////////////////////////

    /// deposit msg.value of Ether to msg.sender balance
    function deposit()
        public
        payable
    {
        depositPrivate();
        emit Transfer(address(0), msg.sender, msg.value);
    }

    /// @notice convenience function to deposit and immediately transfer amount
    /// @param transferTo where to transfer after deposit
    /// @param amount total amount to transfer, must be <= balance after deposit
    /// @param data erc223 data
    /// @dev intended to deposit from simple account and invest in ETO
    function depositAndTransfer(address transferTo, uint256 amount, bytes data)
        public
        payable
    {
        depositPrivate();
        transfer(transferTo, amount, data);
    }

    /// withdraws and sends 'amount' of ether to msg.sender
    function withdraw(uint256 amount)
        public
    {
        withdrawPrivate(amount);
        msg.sender.transfer(amount);
    }

    /// @notice convenience function to withdraw and transfer to external account
    /// @param sendTo address to which send total amount
    /// @param amount total amount to withdraw and send
    /// @dev function is payable and is meant to withdraw funds on accounts balance and token in single transaction
    /// @dev BEWARE that msg.sender of the funds is Ether Token contract and not simple account calling it.
    /// @dev  when sent to smart conctract funds may be lost, so this is prevented below
    function withdrawAndSend(address sendTo, uint256 amount)
        public
        payable
    {
        // must send at least what is in msg.value to being another deposit function
        require(amount >= msg.value, "NF_ET_NO_DEPOSIT");
        if (amount > msg.value) {
            uint256 withdrawRemainder = amount - msg.value;
            withdrawPrivate(withdrawRemainder);
        }
        emit LogWithdrawAndSend(msg.sender, sendTo, amount);
        sendTo.transfer(amount);
    }

    //
    // Implements IERC223Token
    //

    function transfer(address to, uint256 amount, bytes data)
        public
        returns (bool)
    {
        BasicToken.mTransfer(msg.sender, to, amount);

        // Notify the receiving contract.
        if (isContract(to)) {
            // in case of re-entry (1) transfer is done (2) msg.sender is different
            IERC223Callback(to).tokenFallback(msg.sender, amount, data);
        }
        return true;
    }

    //
    // Overrides Reclaimable
    //

    /// @notice allows EtherToken to reclaim tokens wrongly sent to its address
    /// @dev as EtherToken by design has balance of Ether (native Ethereum token)
    ///     such reclamation is not allowed
    function reclaim(IBasicToken token)
        public
    {
        // forbid reclaiming ETH hold in this contract.
        require(token != RECLAIM_ETHER);
        Reclaimable.reclaim(token);
    }

    //
    // Implements IContractId
    //

    function contractId() public pure returns (bytes32 id, uint256 version) {
        return (0x75b86bc24f77738576716a36431588ae768d80d077231d1661c2bea674c6373a, 0);
    }


    ////////////////////////
    // Private functions
    ////////////////////////

    function depositPrivate()
        private
    {
        _balances[msg.sender] = Math.add(_balances[msg.sender], msg.value);
        _totalSupply = Math.add(_totalSupply, msg.value);
        emit LogDeposit(msg.sender, msg.value);
    }

    function withdrawPrivate(uint256 amount)
        private
    {
        require(_balances[msg.sender] >= amount);
        _balances[msg.sender] = Math.sub(_balances[msg.sender], amount);
        _totalSupply = Math.sub(_totalSupply, amount);
        emit LogWithdrawal(msg.sender, amount);
        emit Transfer(msg.sender, address(0), amount);
    }
}
